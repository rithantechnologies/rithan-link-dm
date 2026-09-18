require("dotenv").config();

const pool = require("../db");

const dryRun =
  process.argv.includes("--dry-run");

const retentionDays =
  Math.max(
    1,
    Number(
      process.env
        .WEBHOOK_EVENT_RETENTION_DAYS ||
      30
    )
  );

async function main() {
  const client =
    await pool.connect();

  try {
    const params = [
      retentionDays
    ];

    const whereSql = `
      received_at <
        NOW() - (
          $1::double precision *
          INTERVAL '1 day'
        )
    `;

    if (dryRun) {
      const result =
        await client.query(
          `
          SELECT COUNT(*)::bigint AS count
          FROM webhook_events
          WHERE ${whereSql}
          `,
          params
        );

      console.log({
        dryRun: true,
        removableWebhookEvents:
          Number(
            result.rows[0].count
          ),
        retentionDays
      });

      return;
    }

    const result =
      await client.query(
        `
        DELETE FROM webhook_events
        WHERE ${whereSql}
        `,
        params
      );

    console.log({
      deletedWebhookEvents:
        result.rowCount,
      retentionDays
    });

  } finally {
    client.release();
  }
}

main()
  .catch(error => {
    console.error(
      "Webhook event cleanup failed:",
      error.message
    );

    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
