const express = require("express");
const pool = require("../db");

const { requireAuth } = require("../lib/auth");
const { requireSameOrigin } = require("../lib/same-origin");
const { requireWorkspaceEditor } = require("../lib/workspace-policy");
const { safeAuditLog } = require("../lib/audit-log");

const {
  ABS_HOURLY_DM_MAX,
  ABS_DAILY_DM_MAX,
  getSafetySnapshot
} = require("../lib/instagram-safety");

const router = express.Router();

router.use(requireAuth);
router.use(requireSameOrigin);

async function getWorkspaceAccount(accountId, workspaceId) {
  const result = await pool.query(
    `SELECT
       ia.id,
       ia.username,
       ia.account_type,
       latest.status,
       latest.token_expires_at,
       latest.token_last_refreshed_at,
       latest.comments_subscribed_at,
       latest.connected_at,
       latest.last_error
     FROM instagram_accounts ia
     JOIN LATERAL (
       SELECT
         ic.workspace_id,
         ic.status,
         ic.token_expires_at,
         ic.token_last_refreshed_at,
         ic.comments_subscribed_at,
         ic.connected_at,
         ic.last_error,
         ic.created_at
       FROM instagram_connections ic
       WHERE ic.instagram_account_id = ia.id
       ORDER BY ic.connected_at DESC, ic.created_at DESC
       LIMIT 1
     ) latest ON TRUE
     WHERE ia.id = $1
       AND latest.workspace_id = $2
     LIMIT 1`,
    [accountId, workspaceId]
  );

  return result.rows[0] || null;
}

function integerInRange(value, min, max) {
  if (value === undefined) return null;
  const parsed = Number(value);
  if (
    !Number.isInteger(parsed) ||
    parsed < min ||
    parsed > max
  ) {
    return undefined;
  }
  return parsed;
}

router.get("/:id/safety", async (req, res) => {
  try {
    const account = await getWorkspaceAccount(
      req.params.id,
      req.auth.workspaceId
    );

    if (!account) {
      return res.status(404).json({
        error: "instagram_account_not_found"
      });
    }

    const snapshot = await getSafetySnapshot(pool, account.id);

    return res.json({
      account: {
        id: account.id,
        username: account.username,
        status: account.status
      },
      ...snapshot,
      absoluteCaps: {
        hourlyDm: ABS_HOURLY_DM_MAX,
        dailyDm: ABS_DAILY_DM_MAX
      }
    });
  } catch (error) {
    console.error("Instagram safety lookup failed:", error.message);
    return res.sendStatus(500);
  }
});

router.patch(
  "/:id/safety",
  requireWorkspaceEditor,
  async (req, res) => {
    try {
      const account = await getWorkspaceAccount(
        req.params.id,
        req.auth.workspaceId
      );

      if (!account) {
        return res.status(404).json({
          error: "instagram_account_not_found"
        });
      }

      const input = {
        hourlyDmLimit: integerInRange(
          req.body?.hourlyDmLimit, 1, ABS_HOURLY_DM_MAX
        ),
        dailyDmLimit: integerInRange(
          req.body?.dailyDmLimit, 1, ABS_DAILY_DM_MAX
        ),
        hourlyPublicReplyLimit: integerInRange(
          req.body?.hourlyPublicReplyLimit, 0, 200
        ),
        dailyPublicReplyLimit: integerInRange(
          req.body?.dailyPublicReplyLimit, 0, 500
        ),
        commenterCooldownSeconds: integerInRange(
          req.body?.commenterCooldownSeconds, 0, 604800
        ),
        circuitBreakerThreshold: integerInRange(
          req.body?.circuitBreakerThreshold, 1, 20
        ),
        circuitBreakerPauseMinutes: integerInRange(
          req.body?.circuitBreakerPauseMinutes, 1, 1440
        )
      };

      if (Object.values(input).some(value => value === undefined)) {
        return res.status(400).json({
          error: "invalid_instagram_safety_policy"
        });
      }

      const currentSafety =
        await getSafetySnapshot(
          pool,
          account.id
        );

      if (currentSafety.policy.mode === "pilot") {
        const exceedsPilot =
          (input.hourlyDmLimit !== null && input.hourlyDmLimit > 30) ||
          (input.dailyDmLimit !== null && input.dailyDmLimit > 100) ||
          (input.hourlyPublicReplyLimit !== null && input.hourlyPublicReplyLimit > 0) ||
          (input.dailyPublicReplyLimit !== null && input.dailyPublicReplyLimit > 0);

        if (exceedsPilot) {
          return res.status(409).json({
            error: "pilot_mode_limits_locked",
            limits: {
              hourlyDm: 30,
              dailyDm: 100,
              hourlyPublicReply: 0,
              dailyPublicReply: 0
            }
          });
        }
      }

      await pool.query(
        `INSERT INTO instagram_delivery_safety (instagram_account_id)
         VALUES ($1)
         ON CONFLICT (instagram_account_id) DO NOTHING`,
        [account.id]
      );

      await pool.query(
        `UPDATE instagram_delivery_safety
         SET hourly_dm_limit = COALESCE($2, hourly_dm_limit),
             daily_dm_limit = COALESCE($3, daily_dm_limit),
             hourly_public_reply_limit =
               COALESCE($4, hourly_public_reply_limit),
             daily_public_reply_limit =
               COALESCE($5, daily_public_reply_limit),
             commenter_cooldown_seconds =
               COALESCE($6, commenter_cooldown_seconds),
             circuit_breaker_threshold =
               COALESCE($7, circuit_breaker_threshold),
             circuit_breaker_pause_minutes =
               COALESCE($8, circuit_breaker_pause_minutes),
             updated_at = NOW()
         WHERE instagram_account_id = $1`,
        [
          account.id,
          input.hourlyDmLimit,
          input.dailyDmLimit,
          input.hourlyPublicReplyLimit,
          input.dailyPublicReplyLimit,
          input.commenterCooldownSeconds,
          input.circuitBreakerThreshold,
          input.circuitBreakerPauseMinutes
        ]
      );

      await safeAuditLog({
        workspaceId: req.auth.workspaceId,
        userId: req.auth.userId,
        eventType: "instagram.safety_policy_updated",
        targetType: "instagram_account",
        targetId: account.id,
        ipAddress: req.ip,
        userAgent: req.get("user-agent"),
        metadata: input
      });

      return res.json(await getSafetySnapshot(pool, account.id));
    } catch (error) {
      console.error("Instagram safety update failed:", error.message);
      return res.sendStatus(500);
    }
  }
);

router.post(
  "/:id/safety/unpause",
  requireWorkspaceEditor,
  async (req, res) => {
    try {
      const account = await getWorkspaceAccount(
        req.params.id,
        req.auth.workspaceId
      );

      if (!account) {
        return res.status(404).json({
          error: "instagram_account_not_found"
        });
      }

      await pool.query(
        `INSERT INTO instagram_delivery_safety (instagram_account_id)
         VALUES ($1)
         ON CONFLICT (instagram_account_id) DO NOTHING`,
        [account.id]
      );

      await pool.query(
        `UPDATE instagram_delivery_safety
         SET paused_until = NULL,
             pause_reason = NULL,
             consecutive_platform_failures = 0,
             updated_at = NOW()
         WHERE instagram_account_id = $1`,
        [account.id]
      );

      await safeAuditLog({
        workspaceId: req.auth.workspaceId,
        userId: req.auth.userId,
        eventType: "instagram.safety_unpaused",
        targetType: "instagram_account",
        targetId: account.id,
        ipAddress: req.ip,
        userAgent: req.get("user-agent")
      });

      return res.json({ ok: true });
    } catch (error) {
      console.error("Instagram safety unpause failed:", error.message);
      return res.sendStatus(500);
    }
  }
);

router.post(
  "/:id/safety/promote",
  requireWorkspaceEditor,
  async (req, res) => {
    try {
      const account = await getWorkspaceAccount(
        req.params.id,
        req.auth.workspaceId
      );

      if (!account) {
        return res.status(404).json({
          error: "instagram_account_not_found"
        });
      }

      const snapshot =
        await getSafetySnapshot(
          pool,
          account.id
        );

      if (snapshot.policy.mode === "normal") {
        return res.json({
          ok: true,
          alreadyNormal: true,
          safety: snapshot
        });
      }

      const pilotMinHours = Math.max(
        1,
        Number(
          process.env.INSTAGRAM_PILOT_MIN_HOURS ||
          48
        )
      );

      const connectedHours =
        account.connected_at
          ? (
              Date.now() -
              new Date(account.connected_at).getTime()
            ) / 3600000
          : 0;

      const delivery = await pool.query(
        `SELECT
           COUNT(*) FILTER (
             WHERE status = 'sent'
           )::integer AS sent,
           COUNT(*) FILTER (
             WHERE status = 'failed'
           )::integer AS failed
         FROM dm_logs
         WHERE instagram_account_id = $1
           AND updated_at >= NOW() - INTERVAL '48 hours'`,
        [account.id]
      );

      const externalAccessConfirmed =
        String(
          process.env.META_EXTERNAL_CUSTOMER_ACCESS_CONFIRMED ||
          ""
        ).toLowerCase() === "true";

      const paused =
        snapshot.policy.paused_until &&
        new Date(snapshot.policy.paused_until).getTime() >
          Date.now();

      const checks = {
        pilotAgeComplete:
          connectedHours >= pilotMinHours,
        manualPreflightConfirmed:
          Boolean(
            snapshot.policy
              .manual_preflight_confirmed_at
          ),
        metaExternalCustomerAccessConfirmed:
          externalAccessConfirmed,
        atLeastOneSuccessfulDm:
          Number(delivery.rows[0].sent) >= 1,
        noRecentDmFailures:
          Number(delivery.rows[0].failed) === 0,
        safetyNotPaused: !paused
      };

      if (!Object.values(checks).every(Boolean)) {
        return res.status(409).json({
          error: "pilot_promotion_not_ready",
          checks,
          connectedHours:
            Number(connectedHours.toFixed(1)),
          requiredPilotHours: pilotMinHours
        });
      }

      const hourlyDm = Math.min(
        ABS_HOURLY_DM_MAX,
        Math.max(
          1,
          Number(
            process.env
              .INSTAGRAM_NORMAL_HOURLY_DM_LIMIT ||
            60
          )
        )
      );

      const dailyDm = Math.min(
        ABS_DAILY_DM_MAX,
        Math.max(
          1,
          Number(
            process.env
              .INSTAGRAM_NORMAL_DAILY_DM_LIMIT ||
            250
          )
        )
      );

      const hourlyReply = Math.min(
        200,
        Math.max(
          0,
          Number(
            process.env
              .INSTAGRAM_NORMAL_HOURLY_PUBLIC_REPLY_LIMIT ||
            30
          )
        )
      );

      const dailyReply = Math.min(
        500,
        Math.max(
          0,
          Number(
            process.env
              .INSTAGRAM_NORMAL_DAILY_PUBLIC_REPLY_LIMIT ||
            100
          )
        )
      );

      await pool.query(
        `UPDATE instagram_delivery_safety
         SET mode = 'normal',
             promoted_at = NOW(),
             hourly_dm_limit = $2,
             daily_dm_limit = $3,
             hourly_public_reply_limit = $4,
             daily_public_reply_limit = $5,
             updated_at = NOW()
         WHERE instagram_account_id = $1`,
        [
          account.id,
          hourlyDm,
          dailyDm,
          hourlyReply,
          dailyReply
        ]
      );

      await safeAuditLog({
        workspaceId: req.auth.workspaceId,
        userId: req.auth.userId,
        eventType:
          "instagram.safety_promoted_to_normal",
        targetType: "instagram_account",
        targetId: account.id,
        ipAddress: req.ip,
        userAgent: req.get("user-agent"),
        metadata: {
          connectedHours,
          hourlyDm,
          dailyDm,
          hourlyReply,
          dailyReply
        }
      });

      return res.json({
        ok: true,
        safety:
          await getSafetySnapshot(
            pool,
            account.id
          )
      });
    } catch (error) {
      console.error(
        "Instagram safety promotion failed:",
        error.message
      );
      return res.sendStatus(500);
    }
  }
);

router.post(
  "/:id/preflight/confirm",
  requireWorkspaceEditor,
  async (req, res) => {
    try {
      const account = await getWorkspaceAccount(
        req.params.id,
        req.auth.workspaceId
      );

      if (!account) {
        return res.status(404).json({
          error: "instagram_account_not_found"
        });
      }

      const manualChecks = [
        req.body?.accountStatusHealthy === true,
        req.body?.twoFactorEnabled === true,
        req.body?.noCompetingAutomation === true
      ];

      if (!manualChecks.every(Boolean)) {
        return res.status(400).json({
          error: "manual_preflight_checks_required",
          required: [
            "accountStatusHealthy",
            "twoFactorEnabled",
            "noCompetingAutomation"
          ]
        });
      }

      await pool.query(
        `INSERT INTO instagram_delivery_safety (instagram_account_id)
         VALUES ($1)
         ON CONFLICT (instagram_account_id) DO NOTHING`,
        [account.id]
      );

      await pool.query(
        `UPDATE instagram_delivery_safety
         SET manual_preflight_confirmed_at = NOW(),
             manual_preflight_confirmed_by = $2,
             manual_preflight_notes = $3,
             updated_at = NOW()
         WHERE instagram_account_id = $1`,
        [
          account.id,
          req.auth.userId,
          String(req.body?.notes || "").slice(0, 2000) || null
        ]
      );

      await safeAuditLog({
        workspaceId: req.auth.workspaceId,
        userId: req.auth.userId,
        eventType: "instagram.preflight_confirmed",
        targetType: "instagram_account",
        targetId: account.id,
        ipAddress: req.ip,
        userAgent: req.get("user-agent"),
        metadata: {
          accountStatusHealthy: true,
          twoFactorEnabled: true,
          noCompetingAutomation: true
        }
      });

      return res.json({ ok: true });
    } catch (error) {
      console.error(
        "Instagram preflight confirmation failed:",
        error.message
      );
      return res.sendStatus(500);
    }
  }
);

router.get("/:id/preflight", async (req, res) => {
  try {
    const account = await getWorkspaceAccount(
      req.params.id,
      req.auth.workspaceId
    );

    if (!account) {
      return res.status(404).json({
        error: "instagram_account_not_found"
      });
    }

    const snapshot = await getSafetySnapshot(pool, account.id);

    const failures = await pool.query(
      `SELECT
         COUNT(*) FILTER (
           WHERE d.status = 'failed'
         )::integer AS dm_failures,
         (
           SELECT COUNT(*)::integer
           FROM public_reply_logs p
           WHERE p.instagram_account_id = $1
             AND p.status = 'failed'
             AND p.updated_at >= NOW() - INTERVAL '24 hours'
         ) AS public_reply_failures
       FROM dm_logs d
       WHERE d.instagram_account_id = $1
         AND d.updated_at >= NOW() - INTERVAL '24 hours'`,
      [account.id]
    );

    const automation = await pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE active = TRUE)::integer AS active_count,
         COUNT(*) FILTER (
           WHERE active = TRUE
             AND public_reply_enabled = TRUE
         )::integer AS public_reply_count
       FROM automations
       WHERE instagram_account_id = $1`,
      [account.id]
    );

    const tokenDays = account.token_expires_at
      ? (
          new Date(account.token_expires_at).getTime() -
          Date.now()
        ) / 86400000
      : null;

    const policy = snapshot.policy;
    const isPaused = Boolean(
      policy.paused_until &&
      new Date(policy.paused_until).getTime() > Date.now()
    );

    const checks = [
      {
        id: "professional_account",
        pass: ["BUSINESS", "MEDIA_CREATOR", "CREATOR"].includes(
          String(account.account_type || "").toUpperCase()
        )
      },
      { id: "connected", pass: account.status === "connected" },
      {
        id: "comments_webhook_subscribed",
        pass: Boolean(account.comments_subscribed_at)
      },
      {
        id: "token_healthy",
        pass: Number.isFinite(tokenDays) && tokenDays > 14,
        detail: tokenDays
      },
      {
        id: "safety_not_paused",
        pass: !isPaused,
        detail: policy.pause_reason || null
      },
      {
        id: "no_recent_delivery_failures",
        pass:
          Number(failures.rows[0].dm_failures) === 0 &&
          Number(failures.rows[0].public_reply_failures) === 0
      },
      {
        id: "pilot_limits",
        pass:
          policy.mode !== "pilot" ||
          (
            snapshot.effectiveDmLimits.hourly <= 30 &&
            snapshot.effectiveDmLimits.daily <= 100
          )
      },
      {
        id: "public_replies_disabled_for_pilot",
        pass:
          policy.mode !== "pilot" ||
          Number(automation.rows[0].public_reply_count) === 0
      },
      {
        id: "manual_account_preflight_confirmed",
        pass: Boolean(policy.manual_preflight_confirmed_at)
      },
      {
        id: "meta_external_customer_access_confirmed",
        pass:
          String(
            process.env.META_EXTERNAL_CUSTOMER_ACCESS_CONFIRMED || ""
          ).toLowerCase() === "true"
      }
    ];

    return res.json({
      ready: checks.every(check => check.pass),
      account: {
        id: account.id,
        username: account.username,
        accountType: account.account_type,
        status: account.status
      },
      checks,
      tokenDaysRemaining: Number.isFinite(tokenDays)
        ? Number(tokenDays.toFixed(1))
        : null,
      recentFailures: failures.rows[0],
      activeAutomations: Number(automation.rows[0].active_count),
      safety: snapshot,
      manualRequirements: [
        "Instagram Account Status has no active restriction",
        "Two-factor authentication is enabled",
        "No competing auto-DM/comment automation is connected"
      ]
    });
  } catch (error) {
    console.error("Instagram preflight failed:", error.message);
    return res.sendStatus(500);
  }
});

module.exports = router;
