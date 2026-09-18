const pool = require("../db");

function subscriptionAllowsUsage(status) {
  return [
    "active",
    "trialing"
  ].includes(
    String(status || "")
      .toLowerCase()
  );
}

async function getWorkspaceEntitlements(
  workspaceId
) {
  const result =
    await pool.query(
      `
      SELECT
        ws.workspace_id,

        ws.plan_code,
        ws.status,

        ws.current_period_start,
        ws.current_period_end,

        p.name AS plan_name,

        p.max_instagram_accounts,
        p.max_active_automations,
        p.monthly_dm_limit,
        p.activity_history_days,

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

      LIMIT 1
      `,
      [
        workspaceId
      ]
    );

  if (result.rowCount === 0) {
    return null;
  }

  const row =
    result.rows[0];

  const sent =
    Number(
      row.dm_sent_count
    );

  const limit =
    Number(
      row.monthly_dm_limit
    );

  return {
    workspaceId:
      row.workspace_id,

    planCode:
      row.plan_code,

    planName:
      row.plan_name,

    status:
      row.status,

    currentPeriodStart:
      row.current_period_start,

    currentPeriodEnd:
      row.current_period_end,

    maxInstagramAccounts:
      row.max_instagram_accounts,

    maxActiveAutomations:
      row.max_active_automations,

    monthlyDmLimit:
      limit,

    activityHistoryDays:
      row.activity_history_days,

    monthlyDmSent:
      sent,

    monthlyDmRemaining:
      Math.max(
        0,
        limit - sent
      ),

    monthlyDmLimitReached:
      sent >= limit
  };
}


async function getWorkspaceInstagramAccountCount(
  workspaceId
) {
  const result =
    await pool.query(
      `
      SELECT
        COUNT(*)::integer AS count

      FROM instagram_accounts ia

      JOIN LATERAL (
        SELECT
          ic.workspace_id,
          ic.status

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

      WHERE
        latest.workspace_id = $1

        AND latest.status IN (
          'connected',
          'reauth_required'
        )
      `,
      [
        workspaceId
      ]
    );

  return Number(
    result.rows[0].count
  );
}


async function getWorkspaceActiveAutomationCount(
  workspaceId
) {
  const result =
    await pool.query(
      `
      SELECT
        COUNT(*)::integer AS count

      FROM automations a

      JOIN instagram_accounts ia
        ON ia.id =
           a.instagram_account_id

      JOIN LATERAL (
        SELECT
          ic.workspace_id,
          ic.status

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

      WHERE
        latest.workspace_id = $1

        AND latest.status IN (
          'connected',
          'reauth_required'
        )

        AND a.active = TRUE
      `,
      [
        workspaceId
      ]
    );

  return Number(
    result.rows[0].count
  );
}


module.exports = {
  subscriptionAllowsUsage,
  getWorkspaceEntitlements,
  getWorkspaceInstagramAccountCount,
  getWorkspaceActiveAutomationCount
};
