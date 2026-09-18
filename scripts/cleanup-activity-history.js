require("dotenv").config();

const pool = require("../db");

const dryRun =
  process.argv.includes("--dry-run");

const retentionJoin = `
  EXISTS (
    SELECT 1
    FROM instagram_connections ic
    JOIN workspace_subscriptions ws
      ON ws.workspace_id = ic.workspace_id
    JOIN plans p
      ON p.code = ws.plan_code
    WHERE
      ic.instagram_account_id = ACCOUNT_COLUMN
      AND ic.id = (
        SELECT ic2.id
        FROM instagram_connections ic2
        WHERE
          ic2.instagram_account_id =
            ic.instagram_account_id
        ORDER BY
          ic2.connected_at DESC,
          ic2.created_at DESC
        LIMIT 1
      )
      AND AGE_COLUMN < CUTOFF_EXPRESSION
  )
`;

function scopedWhere({
  accountColumn,
  ageColumn,
  cutoffExpression
}) {
  return retentionJoin
    .replace(
      "ACCOUNT_COLUMN",
      accountColumn
    )
    .replace(
      "AGE_COLUMN",
      ageColumn
    )
    .replace(
      "CUTOFF_EXPRESSION",
      cutoffExpression
    );
}

async function countRows(
  client,
  table,
  whereSql,
  terminalSql
) {
  const result =
    await client.query(
      `
      SELECT COUNT(*)::bigint AS count
      FROM ${table}
      WHERE
        ${terminalSql}
        AND ${whereSql}
      `
    );

  return Number(
    result.rows[0].count
  );
}

async function deleteRows(
  client,
  table,
  whereSql,
  terminalSql
) {
  const result =
    await client.query(
      `
      DELETE FROM ${table}
      WHERE
        ${terminalSql}
        AND ${whereSql}
      `
    );

  return result.rowCount;
}
async function main() {
  const client =
    await pool.connect();

  try {
    await client.query("BEGIN");

    const processedWhere =
      scopedWhere({
        accountColumn:
          "processed_comments.instagram_account_id",
        ageColumn:
          "processed_comments.received_at",
        cutoffExpression:
          "NOW() - (p.activity_history_days * INTERVAL '1 day')"
      });

    const publicReplyWhere =
      scopedWhere({
        accountColumn:
          "public_reply_logs.instagram_account_id",
        ageColumn:
          "public_reply_logs.created_at",
        cutoffExpression:
          "NOW() - (p.activity_history_days * INTERVAL '1 day')"
      });

    // Keep all current-month DM logs even when the
    // visible activity-history window is shorter.
    // Monthly quota reconciliation depends on them.
    const dmWhere =
      scopedWhere({
        accountColumn:
          "dm_logs.instagram_account_id",
        ageColumn:
          "dm_logs.created_at",
        cutoffExpression:
          "LEAST(NOW() - (p.activity_history_days * INTERVAL '1 day'), date_trunc('month', NOW()))"
      });
    const targets = [
      {
        table: "processed_comments",
        where: processedWhere,
        terminal:
          "status IN ('completed','ignored','failed')"
      },
      {
        table: "public_reply_logs",
        where: publicReplyWhere,
        terminal:
          "status IN ('sent','failed','skipped')"
      },
      {
        table: "dm_logs",
        where: dmWhere,
        terminal:
          "status IN ('sent','failed','expired','skipped')"
      }
    ];

    const summary = {};

    for (const target of targets) {
      summary[target.table] =
        dryRun
          ? await countRows(
              client,
              target.table,
              target.where,
              target.terminal
            )
          : await deleteRows(
              client,
              target.table,
              target.where,
              target.terminal
            );
    }

    if (dryRun) {
      await client.query("ROLLBACK");
    } else {
      await client.query("COMMIT");
    }

    console.log(
      dryRun
        ? "Activity retention dry run:"
        : "Activity retention cleanup:"
    );

    console.table(summary);
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {}

    throw error;

  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error) => {
  console.error(
    "Activity retention cleanup failed:",
    error
  );

  process.exit(1);
});
