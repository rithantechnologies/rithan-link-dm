require("dotenv").config();

const pool = require("../db");

const {
  instagramQueue,
  closeInstagramQueue
} = require("../lib/instagram-queue");

const DRY_RUN =
  process.argv.includes("--dry-run");

const MAX_TOTAL_ATTEMPTS = 8;

async function main() {
  const lockClient =
    await pool.connect();

  const lockResult =
    await lockClient.query(`
      SELECT
        pg_try_advisory_lock(
          742001235::bigint
        ) AS locked
    `);

  if (!lockResult.rows[0].locked) {
    console.log(
      "Another public reply recovery run is active."
    );

    lockClient.release();
    return;
  }

  try {
    // A worker may have died after marking a row
    // as sending but before finishing the API call.
    const stale =
      await pool.query(`
        SELECT COUNT(*)::int AS count
        FROM public_reply_logs
        WHERE status = 'sending'
          AND updated_at <
              NOW() - INTERVAL '10 minutes'
      `);

    console.log(
      "Stale sending rows:",
      stale.rows[0].count
    );

    if (!DRY_RUN) {
      await pool.query(`
        UPDATE public_reply_logs
        SET
          status = 'failed',
          failure_message =
            'Recovered stale sending state',
          updated_at = NOW()
        WHERE status = 'sending'
          AND updated_at <
              NOW() - INTERVAL '10 minutes'
      `);
    }

    const candidates =
      await pool.query(
        `
        SELECT
          prl.comment_id,
          prl.status,
          prl.attempt_count,

          ia.professional_account_id,
          ia.username

        FROM public_reply_logs prl

        JOIN instagram_accounts ia
          ON ia.id =
             prl.instagram_account_id

        JOIN instagram_connections ic
          ON ic.instagram_account_id =
             ia.id
         AND ic.status = 'connected'

        JOIN workspace_subscriptions ws
          ON ws.workspace_id = ic.workspace_id

        JOIN automations a
          ON a.id = prl.automation_id

        WHERE
          ws.status IN (
            'active',
            'trialing'
          )

          AND prl.status IN (
          'pending',
          'failed'
        )

          AND prl.attempt_count < $1

          AND prl.created_at >
              NOW() - INTERVAL '6 days'

          AND a.public_reply_enabled = TRUE

          AND a.public_reply_template
              IS NOT NULL

        ORDER BY prl.created_at ASC

        LIMIT 100
        `,
        [MAX_TOTAL_ATTEMPTS]
      );

    console.log(
      `Public reply recovery candidates: ${candidates.rows.length}`
    );

    for (const row of candidates.rows) {
      if (DRY_RUN) {
        console.log(
          "DRY RUN: would recover:",
          {
            username: row.username,
            commentId: row.comment_id,
            status: row.status,
            attempts: row.attempt_count
          }
        );

        continue;
      }

      // Unique recovery job ID avoids collision with
      // the original public-{commentId} BullMQ job.
      const jobId =
        `public-recovery-${row.comment_id}-${Date.now()}`;

      await instagramQueue.add(
        "instagram-public-reply",
        {
          commentId:
            row.comment_id,

          professionalAccountId:
            row.professional_account_id
        },
        {
          jobId,

          attempts: 3,

          backoff: {
            type: "exponential",
            delay: 10000
          }
        }
      );

      console.log(
        "Public reply recovery queued:",
        {
          username: row.username,
          commentId: row.comment_id,
          jobId
        }
      );
    }

  } finally {
    await lockClient.query(`
      SELECT
        pg_advisory_unlock(
          742001235::bigint
        )
    `);

    lockClient.release();
  }
}

main()
  .catch((error) => {
    console.error(
      "Public reply recovery failed:",
      error
    );

    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await closeInstagramQueue();
    } catch {}

    await pool.end();
  });
