const pool = require("../db");

const ABS_HOURLY_DM_MAX = Math.min(
  500,
  Math.max(1, Number(process.env.INSTAGRAM_ABSOLUTE_HOURLY_DM_MAX || 500))
);

const ABS_DAILY_DM_MAX = Math.min(
  2000,
  Math.max(1, Number(process.env.INSTAGRAM_ABSOLUTE_DAILY_DM_MAX || 2000))
);

async function ensurePolicy(client, accountId) {
  await client.query(
    `INSERT INTO instagram_delivery_safety (instagram_account_id)
     VALUES ($1)
     ON CONFLICT (instagram_account_id) DO NOTHING`,
    [accountId]
  );
}

async function lockAccount(client, accountId) {
  await client.query(
    "SELECT pg_advisory_xact_lock(hashtext($1))",
    [`instagram-safety:${accountId}`]
  );
}

async function loadPolicy(client, accountId, forUpdate = false) {
  await ensurePolicy(client, accountId);
  const result = await client.query(
    `SELECT *
     FROM instagram_delivery_safety
     WHERE instagram_account_id = $1
     ${forUpdate ? "FOR UPDATE" : ""}`,
    [accountId]
  );
  return result.rows[0];
}

function effectiveDmLimits(policy) {
  return {
    hourly: Math.min(Number(policy.hourly_dm_limit), ABS_HOURLY_DM_MAX),
    daily: Math.min(Number(policy.daily_dm_limit), ABS_DAILY_DM_MAX)
  };
}

async function checkDmSafety(client, {
  accountId,
  automationId,
  commenterId,
  commentId
}) {
  await lockAccount(client, accountId);
  const policy = await loadPolicy(client, accountId, true);

  if (policy.paused_until && new Date(policy.paused_until).getTime() > Date.now()) {
    return {
      allowed: false,
      reason: "account_safety_paused",
      pausedUntil: policy.paused_until,
      pauseReason: policy.pause_reason
    };
  }

  const limits = effectiveDmLimits(policy);
  const counts = await client.query(
    `SELECT
       COUNT(*) FILTER (
         WHERE sent_at >= NOW() - INTERVAL '1 hour'
       )::integer AS hourly,
       COUNT(*) FILTER (
         WHERE sent_at >= NOW() - INTERVAL '1 day'
       )::integer AS daily
     FROM dm_logs
     WHERE instagram_account_id = $1
       AND status = 'sent'`,
    [accountId]
  );

  if (Number(counts.rows[0].hourly) >= limits.hourly) {
    return {
      allowed: false,
      reason: "account_hourly_dm_limit_reached",
      current: Number(counts.rows[0].hourly),
      limit: limits.hourly
    };
  }

  if (Number(counts.rows[0].daily) >= limits.daily) {
    return {
      allowed: false,
      reason: "account_daily_dm_limit_reached",
      current: Number(counts.rows[0].daily),
      limit: limits.daily
    };
  }

  const cooldownSeconds = Number(policy.commenter_cooldown_seconds);
  if (commenterId && cooldownSeconds > 0) {
    const prior = await client.query(
      `SELECT dl.sent_at
       FROM dm_logs dl
       JOIN processed_comments pc
         ON pc.comment_id = dl.comment_id
       WHERE dl.instagram_account_id = $1
         AND dl.automation_id = $2
         AND dl.status = 'sent'
         AND pc.commenter_id = $3
         AND dl.comment_id <> $4
         AND dl.sent_at >= NOW() - ($5::integer * INTERVAL '1 second')
       ORDER BY dl.sent_at DESC
       LIMIT 1`,
      [
        accountId,
        automationId,
        commenterId,
        commentId,
        cooldownSeconds
      ]
    );

    if (prior.rowCount) {
      return {
        allowed: false,
        reason: "commenter_cooldown_active",
        cooldownSeconds,
        previousSentAt: prior.rows[0].sent_at
      };
    }
  }

  return {
    allowed: true,
    policy,
    limits,
    hourlySent: Number(counts.rows[0].hourly),
    dailySent: Number(counts.rows[0].daily)
  };
}

async function checkPublicReplySafety(client, { accountId }) {
  await lockAccount(client, accountId);
  const policy = await loadPolicy(client, accountId, true);

  if (policy.paused_until && new Date(policy.paused_until).getTime() > Date.now()) {
    return {
      allowed: false,
      reason: "account_safety_paused",
      pausedUntil: policy.paused_until,
      pauseReason: policy.pause_reason
    };
  }

  const hourlyLimit = Number(policy.hourly_public_reply_limit);
  const dailyLimit = Number(policy.daily_public_reply_limit);

  if (hourlyLimit === 0 || dailyLimit === 0) {
    return { allowed: false, reason: "public_reply_safety_disabled" };
  }

  const counts = await client.query(
    `SELECT
       COUNT(*) FILTER (
         WHERE sent_at >= NOW() - INTERVAL '1 hour'
       )::integer AS hourly,
       COUNT(*) FILTER (
         WHERE sent_at >= NOW() - INTERVAL '1 day'
       )::integer AS daily
     FROM public_reply_logs
     WHERE instagram_account_id = $1
       AND status = 'sent'`,
    [accountId]
  );

  if (Number(counts.rows[0].hourly) >= hourlyLimit) {
    return {
      allowed: false,
      reason: "account_hourly_public_reply_limit_reached",
      current: Number(counts.rows[0].hourly),
      limit: hourlyLimit
    };
  }

  if (Number(counts.rows[0].daily) >= dailyLimit) {
    return {
      allowed: false,
      reason: "account_daily_public_reply_limit_reached",
      current: Number(counts.rows[0].daily),
      limit: dailyLimit
    };
  }

  return {
    allowed: true,
    policy,
    hourlySent: Number(counts.rows[0].hourly),
    dailySent: Number(counts.rows[0].daily)
  };
}

async function recordDeliverySuccess(client, accountId) {
  await ensurePolicy(client, accountId);
  await client.query(
    `UPDATE instagram_delivery_safety
     SET consecutive_platform_failures = 0,
         last_success_at = NOW(),
         paused_until = CASE
           WHEN paused_until IS NOT NULL AND paused_until > NOW()
             THEN paused_until
           ELSE NULL
         END,
         pause_reason = CASE
           WHEN paused_until IS NOT NULL AND paused_until > NOW()
             THEN pause_reason
           ELSE NULL
         END,
         updated_at = NOW()
     WHERE instagram_account_id = $1`,
    [accountId]
  );
}

async function recordPlatformFailure(accountId, signal) {
  if (!signal || !signal.countsTowardCircuitBreaker) {
    return null;
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await lockAccount(client, accountId);
    const policy = await loadPolicy(client, accountId, true);

    const nextFailures =
      Number(policy.consecutive_platform_failures || 0) + 1;

    const forcePause = [
      "rate_limit",
      "auth",
      "permission",
      "restriction"
    ].includes(signal.category);

    const shouldPause =
      forcePause ||
      nextFailures >= Number(policy.circuit_breaker_threshold);

    const basePauseMs =
      Number(policy.circuit_breaker_pause_minutes) * 60 * 1000;
    const requestedPauseMs =
      Math.max(basePauseMs, Number(signal.retryAfterMs || 0));

    const pausedUntil = shouldPause
      ? new Date(Date.now() + requestedPauseMs)
      : policy.paused_until;

    const reason = shouldPause
      ? [signal.category, signal.message].filter(Boolean).join(": ").slice(0, 1000)
      : policy.pause_reason;

    await client.query(
      `UPDATE instagram_delivery_safety
       SET consecutive_platform_failures = $2,
           last_platform_failure_at = NOW(),
           paused_until = $3,
           pause_reason = $4,
           updated_at = NOW()
       WHERE instagram_account_id = $1`,
      [accountId, nextFailures, pausedUntil, reason]
    );

    if (shouldPause) {
      await client.query(
        `INSERT INTO workspace_notifications (
           workspace_id,
           notification_type,
           severity,
           title,
           message,
           action_url,
           dedupe_key
         )
         SELECT
           latest.workspace_id,
           'instagram_safety_pause',
           'critical',
           'Instagram automation paused',
           $2,
           '/dashboard/',
           'instagram-safety:' || $1::text || ':' ||
             to_char(date_trunc('hour', NOW()), 'YYYYMMDDHH24')
         FROM LATERAL (
           SELECT ic.workspace_id
           FROM instagram_connections ic
           WHERE ic.instagram_account_id = $1
           ORDER BY ic.connected_at DESC, ic.created_at DESC
           LIMIT 1
         ) latest
         ON CONFLICT (workspace_id, dedupe_key)
         WHERE dedupe_key IS NOT NULL
         DO NOTHING`,
        [
          accountId,
          `Outbound Instagram automation was paused: ${reason}`
            .slice(0, 2000)
        ]
      );

      await client.query(
        `INSERT INTO service_events (
           service_name,
           severity,
           event_type,
           workspace_id,
           message,
           metadata
         )
         SELECT
           'instagram-worker',
           'critical',
           'instagram_safety_pause',
           latest.workspace_id,
           $2,
           $3::jsonb
         FROM LATERAL (
           SELECT ic.workspace_id
           FROM instagram_connections ic
           WHERE ic.instagram_account_id = $1
           ORDER BY ic.connected_at DESC, ic.created_at DESC
           LIMIT 1
         ) latest`,
        [
          accountId,
          reason,
          JSON.stringify({
            accountId,
            category: signal.category,
            pausedUntil,
            consecutiveFailures: nextFailures
          })
        ]
      );
    }

    await client.query("COMMIT");

    return {
      paused: Boolean(shouldPause),
      pausedUntil,
      consecutiveFailures: nextFailures,
      reason
    };
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    throw error;
  } finally {
    client.release();
  }
}

async function getSafetySnapshot(client, accountId) {
  const policy = await loadPolicy(client, accountId);
  const dm = await client.query(
    `SELECT
       COUNT(*) FILTER (WHERE sent_at >= NOW() - INTERVAL '1 hour')::integer AS hourly,
       COUNT(*) FILTER (WHERE sent_at >= NOW() - INTERVAL '1 day')::integer AS daily
     FROM dm_logs
     WHERE instagram_account_id = $1 AND status = 'sent'`,
    [accountId]
  );
  const replies = await client.query(
    `SELECT
       COUNT(*) FILTER (WHERE sent_at >= NOW() - INTERVAL '1 hour')::integer AS hourly,
       COUNT(*) FILTER (WHERE sent_at >= NOW() - INTERVAL '1 day')::integer AS daily
     FROM public_reply_logs
     WHERE instagram_account_id = $1 AND status = 'sent'`,
    [accountId]
  );

  return {
    policy,
    effectiveDmLimits: effectiveDmLimits(policy),
    usage: {
      dmHourly: Number(dm.rows[0].hourly),
      dmDaily: Number(dm.rows[0].daily),
      publicReplyHourly: Number(replies.rows[0].hourly),
      publicReplyDaily: Number(replies.rows[0].daily)
    }
  };
}

module.exports = {
  ABS_HOURLY_DM_MAX,
  ABS_DAILY_DM_MAX,
  ensurePolicy,
  checkDmSafety,
  checkPublicReplySafety,
  recordDeliverySuccess,
  recordPlatformFailure,
  getSafetySnapshot
};
