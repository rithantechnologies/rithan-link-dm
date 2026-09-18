require("dotenv").config();

const pool = require("../db");

const dryRun =
  process.argv.includes("--dry-run");

const retentionDays =
  Math.max(
    1,
    Number(
      process.env
        .AUDIT_LOG_RETENTION_DAYS ||
      90
    )
  );

async function main() {
  try {
    const params = [
      retentionDays
    ];

    const whereSql = `
      created_at <
        NOW() - (
          $1::double precision *
          INTERVAL '1 day'
        )
    `;

    if (dryRun) {
      const result =
        await pool.query(
          `
          SELECT COUNT(*)::bigint AS count
          FROM audit_logs
          WHERE ${whereSql}
          `,
          params
        );

      console.log({
        dryRun: true,
        removableAuditLogs:
          Number(
            result.rows[0].count
          ),
        retentionDays
      });

      return;
    }

    const result =
      await pool.query(
        `
        DELETE FROM audit_logs
        WHERE ${whereSql}
        `,
        params
      );

    console.log({
      deletedAuditLogs:
        result.rowCount,
      retentionDays
    });

  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(
    "Audit log cleanup failed:",
    error.message
  );

  process.exit(1);
});
