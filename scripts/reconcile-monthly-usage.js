require("dotenv").config();

const pool = require("../db");

async function main() {
  try {
    const result = await pool.query(`
      WITH current_period AS (
        SELECT
          date_trunc(
            'month',
            NOW()
          )::date AS period_start
      ),

      sent_usage AS (
        SELECT
          latest.workspace_id,
          COUNT(*)::bigint
            AS dm_sent_count

        FROM dm_logs dl

        JOIN instagram_accounts ia
          ON ia.id =
             dl.instagram_account_id

        JOIN LATERAL (
          SELECT
            ic.workspace_id

          FROM instagram_connections ic

          WHERE
            ic.instagram_account_id =
              ia.id

          ORDER BY
            ic.connected_at DESC,
            ic.created_at DESC

          LIMIT 1
        ) latest
          ON TRUE

        CROSS JOIN current_period cp

        WHERE
          dl.status = 'sent'

          AND dl.sent_at >=
            cp.period_start

          AND dl.sent_at <
            cp.period_start +
            INTERVAL '1 month'

        GROUP BY
          latest.workspace_id
      ),

      exact_usage AS (
        SELECT
          ws.workspace_id,
          cp.period_start,

          COALESCE(
            su.dm_sent_count,
            0
          )::bigint
            AS dm_sent_count

        FROM workspace_subscriptions ws

        CROSS JOIN current_period cp

        LEFT JOIN sent_usage su
          ON su.workspace_id =
             ws.workspace_id
      )

      INSERT INTO workspace_usage_monthly (
        workspace_id,
        period_start,
        dm_sent_count
      )

      SELECT
        workspace_id,
        period_start,
        dm_sent_count

      FROM exact_usage

      ON CONFLICT (
        workspace_id,
        period_start
      )

      DO UPDATE SET
        dm_sent_count =
          EXCLUDED.dm_sent_count,

        updated_at =
          NOW()

      RETURNING
        workspace_id,
        period_start,
        dm_sent_count,
        dm_reserved_count
    `);

    console.log(
      "Monthly usage reconciled exactly:"
    );

    console.table(
      result.rows
    );

  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(
    "Usage reconciliation failed:",
    error
  );

  process.exit(1);
});
