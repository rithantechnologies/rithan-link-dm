require("dotenv").config();

const pool = require("../db");

const dryRun =
  process.argv.includes("--dry-run");

const retentionDays =
  Math.max(
    0,
    Number(
      process.env
        .OAUTH_STATE_RETENTION_DAYS ||
      7
    )
  );

async function main() {
  const params = [
    retentionDays
  ];

  const whereSql = `
    (
      consumed_at IS NOT NULL
      AND consumed_at <
        NOW() - (
          $1::double precision *
          INTERVAL '1 day'
        )
    )
    OR (
      expires_at <
        NOW() - (
          $1::double precision *
          INTERVAL '1 day'
        )
    )
  `;

  try {
    if (dryRun) {
      const result =
        await pool.query(
          `
          SELECT COUNT(*)::bigint AS count
          FROM oauth_states
          WHERE ${whereSql}
          `,
          params
        );

      console.log({
        dryRun: true,
        removableOAuthStates:
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
        DELETE FROM oauth_states
        WHERE ${whereSql}
        `,
        params
      );

    console.log({
      deletedOAuthStates:
        result.rowCount,
      retentionDays
    });

  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(
    "OAuth state cleanup failed:",
    error.message
  );

  process.exit(1);
});
