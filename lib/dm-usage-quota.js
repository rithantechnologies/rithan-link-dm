const pool = require("../db");
const {
  subscriptionAllowsUsage
} = require("./entitlements");


async function reserveDmSlot(
  workspaceId
) {
  const client =
    await pool.connect();

  try {
    await client.query("BEGIN");

    const subscription =
      await client.query(
        `
        SELECT
          ws.plan_code,
          ws.status,
          p.monthly_dm_limit

        FROM workspace_subscriptions ws

        JOIN plans p
          ON p.code =
             ws.plan_code

        WHERE
          ws.workspace_id = $1

        LIMIT 1
        `,
        [
          workspaceId
        ]
      );

    if (
      subscription.rowCount === 0
    ) {
      await client.query(
        "ROLLBACK"
      );

      return {
        allowed: false,
        reason:
          "subscription_not_found"
      };
    }

    const plan =
      subscription.rows[0];

    if (
      !subscriptionAllowsUsage(
        plan.status
      )
    ) {
      await client.query(
        "ROLLBACK"
      );

      return {
        allowed: false,
        reason:
          "subscription_inactive",
        status:
          plan.status
      };
    }

    const periodStart =
      await client.query(
        `
        SELECT
          date_trunc(
            'month',
            NOW()
          )::date
            AS period_start
        `
      );

    const period =
      periodStart.rows[0]
        .period_start;

    await client.query(
      `
      INSERT INTO workspace_usage_monthly (
        workspace_id,
        period_start,
        dm_sent_count,
        dm_reserved_count
      )
      VALUES (
        $1,
        $2,
        0,
        0
      )

      ON CONFLICT (
        workspace_id,
        period_start
      )
      DO NOTHING
      `,
      [
        workspaceId,
        period
      ]
    );

    const usage =
      await client.query(
        `
        SELECT
          dm_sent_count,
          dm_reserved_count

        FROM workspace_usage_monthly

        WHERE
          workspace_id = $1
          AND period_start = $2

        FOR UPDATE
        `,
        [
          workspaceId,
          period
        ]
      );

    const sent =
      Number(
        usage.rows[0]
          .dm_sent_count
      );

    const reserved =
      Number(
        usage.rows[0]
          .dm_reserved_count
      );

    const limit =
      Number(
        plan.monthly_dm_limit
      );

    if (
      sent + reserved >= limit
    ) {
      await client.query(
        "COMMIT"
      );

      return {
        allowed: false,

        reason:
          "monthly_dm_limit_reached",

        plan:
          plan.plan_code,

        sent,
        reserved,
        limit
      };
    }

    await client.query(
      `
      UPDATE workspace_usage_monthly
      SET
        dm_reserved_count =
          dm_reserved_count + 1,

        updated_at =
          NOW()

      WHERE
        workspace_id = $1
        AND period_start = $2
      `,
      [
        workspaceId,
        period
      ]
    );

    await client.query(
      "COMMIT"
    );

    return {
      allowed: true,
      periodStart: period,
      plan:
        plan.plan_code,
      limit
    };

  } catch (error) {
    try {
      await client.query(
        "ROLLBACK"
      );
    } catch {}

    throw error;

  } finally {
    client.release();
  }
}


async function commitDmSlot({
  workspaceId,
  periodStart
}) {
  await pool.query(
    `
    UPDATE workspace_usage_monthly

    SET
      dm_reserved_count =
        GREATEST(
          dm_reserved_count - 1,
          0
        ),

      dm_sent_count =
        dm_sent_count + 1,

      updated_at =
        NOW()

    WHERE
      workspace_id = $1
      AND period_start = $2
    `,
    [
      workspaceId,
      periodStart
    ]
  );
}


async function releaseDmSlot({
  workspaceId,
  periodStart
}) {
  await pool.query(
    `
    UPDATE workspace_usage_monthly

    SET
      dm_reserved_count =
        GREATEST(
          dm_reserved_count - 1,
          0
        ),

      updated_at =
        NOW()

    WHERE
      workspace_id = $1
      AND period_start = $2
    `,
    [
      workspaceId,
      periodStart
    ]
  );
}


module.exports = {
  reserveDmSlot,
  commitDmSlot,
  releaseDmSlot
};
