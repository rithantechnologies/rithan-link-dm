require("dotenv").config();

const crypto = require("crypto");
const pool = require("../db");

const {
  processInstagramCommentJob
} = require(
  "../lib/instagram-comment-processor"
);

async function main() {
  let workspaceId = null;
  let periodStart = null;
  let originalCount = null;
  let testCommentId = null;

  try {
    // Pick one real active automation.
    const automationResult =
      await pool.query(`
        SELECT
          a.id AS automation_id,
          a.instagram_media_id,
          a.keyword,

          ia.id AS instagram_account_id,
          ia.professional_account_id,
          ia.username,

          latest.workspace_id

        FROM automations a

        JOIN instagram_accounts ia
          ON ia.id =
             a.instagram_account_id

        JOIN LATERAL (
          SELECT
            ic.workspace_id

          FROM instagram_connections ic

          WHERE
            ic.instagram_account_id =
              ia.id

            AND ic.status =
              'connected'

          ORDER BY
            ic.connected_at DESC,
            ic.created_at DESC

          LIMIT 1
        ) latest
          ON TRUE

        WHERE
          a.active = TRUE

        ORDER BY
          a.created_at

        LIMIT 1
      `);

    if (automationResult.rowCount === 0) {
      throw new Error(
        "No active connected automation available for test"
      );
    }

    const automation =
      automationResult.rows[0];

    workspaceId =
      automation.workspace_id;

    const entitlementResult =
      await pool.query(
        `
        SELECT
          ws.plan_code,
          p.monthly_dm_limit,

          date_trunc(
            'month',
            NOW()
          )::date AS period_start,

          COALESCE(
            usage.dm_sent_count,
            0
          )::bigint AS dm_sent_count

        FROM workspace_subscriptions ws

        JOIN plans p
          ON p.code =
             ws.plan_code

        LEFT JOIN workspace_usage_monthly usage
          ON usage.workspace_id =
             ws.workspace_id

         AND usage.period_start =
             date_trunc(
               'month',
               NOW()
             )::date

        WHERE
          ws.workspace_id = $1
        `,
        [
          workspaceId
        ]
      );

    if (entitlementResult.rowCount === 0) {
      throw new Error(
        "Workspace subscription not found"
      );
    }

    const entitlement =
      entitlementResult.rows[0];

    periodStart =
      entitlement.period_start;

    originalCount =
      Number(
        entitlement.dm_sent_count
      );

    const limit =
      Number(
        entitlement.monthly_dm_limit
      );

    console.log("Before test:", {
      plan:
        entitlement.plan_code,

      originalCount,
      limit
    });

    // Temporarily put this workspace exactly at quota.
    await pool.query(
      `
      INSERT INTO workspace_usage_monthly (
        workspace_id,
        period_start,
        dm_sent_count
      )
      VALUES ($1,$2,$3)

      ON CONFLICT (
        workspace_id,
        period_start
      )

      DO UPDATE SET
        dm_sent_count =
          EXCLUDED.dm_sent_count,

        updated_at =
          NOW()
      `,
      [
        workspaceId,
        periodStart,
        limit
      ]
    );

    testCommentId =
      "quota-test-" +
      crypto.randomUUID();

    const result =
      await processInstagramCommentJob({
        professionalAccountId:
          automation.professional_account_id,

        value: {
          id:
            testCommentId,

          media: {
            id:
              automation.instagram_media_id
          },

          from: {
            id:
              "quota-test-user",

            username:
              "rithan_quota_test_user"
          },

          text:
            automation.keyword
        }
      });

    console.log(
      "Processor result:",
      result
    );

    const evidence =
      await pool.query(
        `
        SELECT
          dl.status AS dm_status,
          dl.failure_code,

          pc.status AS comment_status,
          pc.ignore_reason

        FROM dm_logs dl

        LEFT JOIN processed_comments pc
          ON pc.comment_id =
             dl.comment_id

        WHERE
          dl.comment_id = $1
        `,
        [
          testCommentId
        ]
      );

    console.log(
      "Database evidence:",
      evidence.rows[0] || null
    );

    if (
      result?.reason !==
      "monthly_dm_limit_reached"
    ) {
      throw new Error(
        "Quota test FAILED: expected monthly_dm_limit_reached"
      );
    }

    if (
      evidence.rows[0]?.dm_status !==
        "skipped" ||
      evidence.rows[0]?.failure_code !==
        "monthly_dm_limit_reached"
    ) {
      throw new Error(
        "Quota test FAILED: dm_logs was not skipped correctly"
      );
    }

    console.log(
      "PASS: quota prevented the Meta DM call."
    );

  } finally {
    // Restore real usage before worker comes back.
    if (
      workspaceId &&
      periodStart &&
      originalCount !== null
    ) {
      await pool.query(
        `
        INSERT INTO workspace_usage_monthly (
          workspace_id,
          period_start,
          dm_sent_count
        )
        VALUES ($1,$2,$3)

        ON CONFLICT (
          workspace_id,
          period_start
        )

        DO UPDATE SET
          dm_sent_count =
            EXCLUDED.dm_sent_count,

          updated_at =
            NOW()
        `,
        [
          workspaceId,
          periodStart,
          originalCount
        ]
      );
    }

    // Remove only our synthetic test records.
    if (testCommentId) {
      await pool.query(
        `
        DELETE FROM dm_logs
        WHERE comment_id = $1
        `,
        [
          testCommentId
        ]
      );

      await pool.query(
        `
        DELETE FROM processed_comments
        WHERE comment_id = $1
        `,
        [
          testCommentId
        ]
      );
    }

    await pool.end();
  }
}

main().catch((error) => {
  console.error(
    "Quota test failed:",
    error
  );

  process.exit(1);
});
