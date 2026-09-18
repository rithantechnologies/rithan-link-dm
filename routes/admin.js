const express = require("express");

const pool = require("../db");

const {
  requireAuth
} = require("../lib/auth");

const {
  requireSameOrigin
} = require("../lib/same-origin");

const {
  safeAuditLog
} = require("../lib/audit-log");

const {
  instagramQueue
} = require("../lib/instagram-queue");

const router =
  express.Router();

router.use(requireAuth);

router.use((req, res, next) => {
  if (
    req.auth
      ?.isSystemAdmin !== true
  ) {
    return res.status(403).json({
      error:
        "system_admin_required"
    });
  }

  next();
});

router.use(requireSameOrigin);

function limitValue(
  value,
  fallback = 50,
  max = 200
) {
  return Math.min(
    Math.max(
      Number(value) || fallback,
      1
    ),
    max
  );
}

router.get(
  "/overview",
  async (req, res) => {
    try {
      const result =
        await pool.query(`
          WITH latest_connections AS (
            SELECT DISTINCT ON (
              instagram_account_id
            )
              instagram_account_id,
              workspace_id,
              status,
              token_expires_at,
              connected_at,
              created_at

            FROM instagram_connections

            ORDER BY
              instagram_account_id,
              connected_at DESC,
              created_at DESC
          )

          SELECT
            (
              SELECT COUNT(*)::integer
              FROM users
              WHERE status = 'active'
            ) AS customers,

            (
              SELECT COUNT(*)::integer
              FROM workspaces
              WHERE status = 'active'
            ) AS workspaces,

            (
              SELECT COUNT(*)::integer
              FROM latest_connections
              WHERE status = 'connected'
            ) AS connected_accounts,

            (
              SELECT COUNT(*)::integer
              FROM automations
              WHERE active = TRUE
            ) AS active_automations,

            (
              SELECT COUNT(*)::integer
              FROM dm_logs
              WHERE
                status = 'sent'
                AND sent_at >=
                  date_trunc(
                    'month',
                    NOW()
                  )
            ) AS dm_sent_this_month,

            (
              SELECT COUNT(*)::integer
              FROM dm_logs
              WHERE
                status = 'failed'
                AND updated_at >=
                  NOW() -
                  INTERVAL '24 hours'
            ) AS dm_failed_24h,

            (
              SELECT COUNT(*)::integer
              FROM public_reply_logs
              WHERE
                status = 'failed'
                AND updated_at >=
                  NOW() -
                  INTERVAL '24 hours'
            ) AS public_reply_failed_24h,

            (
              SELECT COUNT(*)::integer
              FROM latest_connections
              WHERE
                status =
                  'reauth_required'
            ) AS accounts_requiring_reauth,

            (
              SELECT COUNT(*)::integer
              FROM latest_connections
              WHERE
                status = 'connected'
                AND token_expires_at IS NOT NULL
                AND token_expires_at <
                  NOW() +
                  INTERVAL '14 days'
            ) AS tokens_expiring_14d
        `);

      return res.json({
        overview:
          result.rows[0]
      });

    } catch (error) {
      console.error(
        "Admin overview failed:",
        error.message
      );

      return res.sendStatus(500);
    }
  }
);
router.get(
  "/workspaces",
  async (req, res) => {
    try {
      const search =
        String(
          req.query.search || ""
        )
          .trim()
          .toLowerCase();

      const limit =
        limitValue(
          req.query.limit,
          100,
          200
        );

      const result =
        await pool.query(
          `
          SELECT
            w.id,
            w.name,
            w.status,
            w.created_at,

            owner_user.email
              AS owner_email,

            owner_user.display_name
              AS owner_display_name,

            ws.plan_code,
            ws.status
              AS subscription_status,

            p.monthly_dm_limit,

            COALESCE(
              usage.dm_sent_count,
              0
            )::bigint
              AS dm_sent_count,

            COALESCE(
              accounts.connected_accounts,
              0
            )::integer
              AS connected_accounts,

            COALESCE(
              automations.active_automations,
              0
            )::integer
              AS active_automations

          FROM workspaces w

          LEFT JOIN workspace_subscriptions ws
            ON ws.workspace_id = w.id

          LEFT JOIN plans p
            ON p.code = ws.plan_code

          LEFT JOIN LATERAL (
            SELECT
              u.email,
              u.display_name

            FROM workspace_members wm

            JOIN users u
              ON u.id = wm.user_id

            WHERE
              wm.workspace_id = w.id
              AND wm.role = 'owner'

            ORDER BY
              wm.created_at ASC

            LIMIT 1
          ) owner_user
            ON TRUE

          LEFT JOIN LATERAL (
            SELECT
              COUNT(*)::integer
                AS connected_accounts

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
              latest.workspace_id =
                w.id

              AND latest.status IN (
                'connected',
                'reauth_required'
              )
          ) accounts
            ON TRUE

          LEFT JOIN LATERAL (
            SELECT
              COUNT(*)::integer
                AS active_automations

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

              ORDER BY
                ic.connected_at DESC,
                ic.created_at DESC

              LIMIT 1
            ) latest
              ON TRUE

            WHERE
              latest.workspace_id =
                w.id

              AND a.active = TRUE
          ) automations
            ON TRUE

          LEFT JOIN workspace_usage_monthly usage
            ON usage.workspace_id =
               w.id

           AND usage.period_start =
               date_trunc(
                 'month',
                 NOW()
               )::date

          WHERE
            $1 = ''

            OR LOWER(w.name)
              LIKE '%' || $1 || '%'

            OR LOWER(
              COALESCE(
                owner_user.email,
                ''
              )
            )
              LIKE '%' || $1 || '%'

          ORDER BY
            w.created_at DESC

          LIMIT $2
          `,
          [
            search,
            limit
          ]
        );

      return res.json({
        workspaces:
          result.rows
      });

    } catch (error) {
      console.error(
        "Admin workspace list failed:",
        error.message
      );

      return res.sendStatus(500);
    }
  }
);
router.get(
  "/workspaces/:id",
  async (req, res) => {
    try {
      const workspaceId =
        req.params.id;

      const workspaceResult =
        await pool.query(
          `
          SELECT
            w.id,
            w.name,
            w.status,
            w.created_at,

            ws.plan_code,
            ws.status
              AS subscription_status,

            ws.current_period_start,
            ws.current_period_end,

            p.max_instagram_accounts,
            p.max_active_automations,
            p.monthly_dm_limit,
            p.activity_history_days,

            COALESCE(
              usage.dm_sent_count,
              0
            )::bigint
              AS dm_sent_count,

            COALESCE(
              usage.dm_reserved_count,
              0
            )::bigint
              AS dm_reserved_count

          FROM workspaces w

          LEFT JOIN workspace_subscriptions ws
            ON ws.workspace_id = w.id

          LEFT JOIN plans p
            ON p.code = ws.plan_code

          LEFT JOIN workspace_usage_monthly usage
            ON usage.workspace_id = w.id
           AND usage.period_start =
               date_trunc(
                 'month',
                 NOW()
               )::date

          WHERE w.id = $1
          LIMIT 1
          `,
          [workspaceId]
        );

      if (
        workspaceResult.rowCount === 0
      ) {
        return res.status(404).json({
          error:
            "workspace_not_found"
        });
      }

      const [
        members,
        accounts,
        automations,
        activity,
        audit,
        sessions
      ] =
        await Promise.all([
          pool.query(
            `
            SELECT
              u.id,
              u.email,
              u.display_name,
              u.status,
              wm.role,
              wm.created_at

            FROM workspace_members wm

            JOIN users u
              ON u.id = wm.user_id

            WHERE wm.workspace_id = $1

            ORDER BY
              CASE wm.role
                WHEN 'owner' THEN 1
                WHEN 'admin' THEN 2
                ELSE 3
              END,
              wm.created_at ASC
            `,
            [workspaceId]
          ),

          pool.query(
            `
            SELECT
              ia.id,
              ia.professional_account_id,
              ia.username,
              ia.account_type,

              latest.status,
              latest.token_expires_at,
              latest.token_last_refreshed_at,
              latest.comments_subscribed_at,
              latest.connected_at

            FROM instagram_accounts ia

            JOIN LATERAL (
              SELECT
                ic.workspace_id,
                ic.status,
                ic.token_expires_at,
                ic.token_last_refreshed_at,
                ic.comments_subscribed_at,
                ic.connected_at,
                ic.created_at

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

            ORDER BY
              latest.connected_at DESC
            `,
            [workspaceId]
          ),

          pool.query(
            `
            SELECT
              a.id,
              a.instagram_account_id,
              ia.username
                AS instagram_username,
              a.instagram_media_id,
              a.keyword,
              a.match_mode,
              a.destination_url,
              a.public_reply_enabled,
              a.active,
              a.created_at,
              a.updated_at

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

              ORDER BY
                ic.connected_at DESC,
                ic.created_at DESC

              LIMIT 1
            ) latest
              ON TRUE

            WHERE
              latest.workspace_id = $1

            ORDER BY
              a.updated_at DESC
            `,
            [workspaceId]
          ),

          pool.query(
            `
            SELECT
              pc.comment_id,
              pc.commenter_username,
              pc.comment_text,
              pc.status
                AS comment_status,
              pc.ignore_reason,
              pc.received_at,

              ia.username
                AS instagram_username,

              a.keyword
                AS automation_keyword,

              dl.status
                AS dm_status,
              dl.failure_code
                AS dm_failure_code,
              dl.failure_message
                AS dm_failure_message,
              dl.sent_at
                AS dm_sent_at,

              pr.status
                AS public_reply_status,
              pr.failure_message
                AS public_reply_failure_message

            FROM processed_comments pc

            JOIN instagram_accounts ia
              ON ia.id =
                 pc.instagram_account_id

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

            LEFT JOIN automations a
              ON a.id =
                 pc.automation_id

            LEFT JOIN dm_logs dl
              ON dl.comment_id =
                 pc.comment_id

            LEFT JOIN public_reply_logs pr
              ON pr.comment_id =
                 pc.comment_id

            WHERE
              latest.workspace_id = $1

            ORDER BY
              pc.received_at DESC

            LIMIT 50
            `,
            [workspaceId]
          ),

          pool.query(
            `
            SELECT
              id,
              user_id,
              event_type,
              target_type,
              target_id,
              metadata,
              created_at

            FROM audit_logs

            WHERE workspace_id = $1

            ORDER BY
              created_at DESC

            LIMIT 50
            `,
            [workspaceId]
          ),

          pool.query(
            `
            SELECT
              COUNT(*)::integer
                AS active_sessions

            FROM user_sessions

            WHERE
              active_workspace_id = $1
              AND revoked_at IS NULL
              AND expires_at > NOW()
            `,
            [workspaceId]
          )
        ]);

      return res.json({
        workspace:
          workspaceResult.rows[0],

        members:
          members.rows,

        accounts:
          accounts.rows,

        automations:
          automations.rows,

        activity:
          activity.rows,

        audit:
          audit.rows,

        activeSessions:
          sessions.rows[0]
            ?.active_sessions || 0
      });

    } catch (error) {
      console.error(
        "Admin workspace detail failed:",
        error.message
      );

      return res.sendStatus(500);
    }
  }
);
router.get(
  "/errors",
  async (req, res) => {
    try {
      const limit =
        limitValue(
          req.query.limit,
          50,
          200
        );

      const result =
        await pool.query(
          `
          SELECT *
          FROM (
            SELECT
              'dm'::text
                AS source,
              dl.comment_id,
              dl.failure_code,
              dl.failure_message,
              dl.updated_at
                AS occurred_at,

              ia.username
                AS instagram_username,

              latest.workspace_id,
              w.name
                AS workspace_name

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

            JOIN workspaces w
              ON w.id =
                 latest.workspace_id

            WHERE
              dl.status = 'failed'

            UNION ALL

            SELECT
              'public_reply'::text
                AS source,
              pr.comment_id,
              NULL::text
                AS failure_code,
              pr.failure_message,
              pr.updated_at
                AS occurred_at,

              ia.username
                AS instagram_username,

              latest.workspace_id,
              w.name
                AS workspace_name

            FROM public_reply_logs pr

            JOIN instagram_accounts ia
              ON ia.id =
                 pr.instagram_account_id

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

            JOIN workspaces w
              ON w.id =
                 latest.workspace_id

            WHERE
              pr.status = 'failed'
          ) failures

          ORDER BY
            occurred_at DESC

          LIMIT $1
          `,
          [limit]
        );

      return res.json({
        errors:
          result.rows
      });

    } catch (error) {
      console.error(
        "Admin errors failed:",
        error.message
      );

      return res.sendStatus(500);
    }
  }
);
router.get(
  "/system",
  async (req, res) => {
    try {
      const [
        heartbeat,
        tokens
      ] =
        await Promise.all([
          pool.query(`
            SELECT
              service_name,
              heartbeat_at,
              metadata,

              EXTRACT(
                EPOCH FROM (
                  NOW() -
                  heartbeat_at
                )
              )::integer
                AS age_seconds

            FROM service_heartbeats

            ORDER BY
              service_name
          `),

          pool.query(`
            SELECT
              ia.username,
              latest.status,
              latest.token_expires_at,
              latest.token_last_refreshed_at

            FROM instagram_accounts ia

            JOIN LATERAL (
              SELECT
                ic.status,
                ic.token_expires_at,
                ic.token_last_refreshed_at,
                ic.connected_at,
                ic.created_at

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
              latest.status IN (
                'connected',
                'reauth_required'
              )

            ORDER BY
              latest.token_expires_at ASC
          `)
        ]);

      const [
        queueCounts,
        pendingJobs,
        events
      ] = await Promise.all([
        instagramQueue.getJobCounts(
          "waiting",
          "active",
          "delayed",
          "failed",
          "completed",
          "paused"
        ),
        instagramQueue.getJobs(
          ["waiting", "delayed"],
          0,
          0,
          true
        ),
        pool.query(
          `SELECT service_name,severity,event_type,request_id,
                  workspace_id,message,metadata,created_at
           FROM service_events
           WHERE created_at >= NOW()-INTERVAL '24 hours'
           ORDER BY created_at DESC
           LIMIT 100`
        )
      ]);

      const oldestPending =
        pendingJobs[0] || null;

      const oldestPendingAgeSeconds =
        oldestPending?.timestamp
          ? Math.max(
              0,
              Math.round(
                (Date.now() - oldestPending.timestamp) / 1000
              )
            )
          : null;

      return res.json({
        api: {
          status: "healthy",
          checkedAt:
            new Date()
              .toISOString()
        },

        services:
          heartbeat.rows,

        queue: {
          ...queueCounts,
          backlog:
            Number(queueCounts.waiting || 0) +
            Number(queueCounts.delayed || 0),
          oldestPendingAgeSeconds
        },

        tokens:
          tokens.rows,

        events:
          events.rows
      });

    } catch (error) {
      console.error(
        "Admin system status failed:",
        error.message
      );

      return res.sendStatus(500);
    }
  }
);

router.get("/queue", async (req, res) => {
  try {
    const [counts, failed] = await Promise.all([
      instagramQueue.getJobCounts(
        "waiting", "active", "delayed",
        "failed", "completed", "paused"
      ),
      instagramQueue.getJobs(["failed"], 0, 49, false)
    ]);

    return res.json({
      counts,
      failed: failed.map(job => ({
        id: job.id,
        name: job.name,
        attemptsMade: job.attemptsMade,
        failedReason: job.failedReason || null,
        timestamp: job.timestamp,
        processedOn: job.processedOn || null,
        finishedOn: job.finishedOn || null,
        commentId:
          job.data?.value?.id ||
          job.data?.commentId ||
          null,
        professionalAccountId:
          job.data?.professionalAccountId ||
          null
      }))
    });
  } catch (error) {
    console.error("Admin queue lookup failed:", error.message);
    return res.sendStatus(500);
  }
});

router.post("/queue/:id/retry", async (req, res) => {
  try {
    const job = await instagramQueue.getJob(req.params.id);
    if (!job) {
      return res.status(404).json({ error: "queue_job_not_found" });
    }

    await job.retry();

    await safeAuditLog({
      workspaceId: req.auth.workspaceId,
      userId: req.auth.userId,
      eventType: "admin.queue_job_retried",
      targetType: "queue_job",
      targetId: String(job.id),
      ipAddress: req.ip,
      userAgent: req.get("user-agent"),
      metadata: { jobName: job.name }
    });

    return res.json({ retried: true, jobId: job.id });
  } catch (error) {
    console.error("Admin queue retry failed:", error.message);
    return res.status(409).json({
      error: "queue_job_retry_failed",
      message: error.message
    });
  }
});

router.post(
  "/workspaces/:workspaceId/automations/:automationId/pause",
  async (req, res) => {
    try {
      const result = await pool.query(
        `UPDATE automations a
         SET active=FALSE, updated_at=NOW()
         FROM instagram_accounts ia
         JOIN LATERAL (
           SELECT ic.workspace_id
           FROM instagram_connections ic
           WHERE ic.instagram_account_id=ia.id
           ORDER BY ic.connected_at DESC,ic.created_at DESC
           LIMIT 1
         ) latest ON TRUE
         WHERE a.id=$1
           AND a.instagram_account_id=ia.id
           AND latest.workspace_id=$2
         RETURNING a.id,a.keyword,a.active`,
        [
          req.params.automationId,
          req.params.workspaceId
        ]
      );

      if (!result.rowCount) {
        return res.status(404).json({ error: "automation_not_found" });
      }

      await safeAuditLog({
        workspaceId: req.params.workspaceId,
        userId: req.auth.userId,
        eventType: "admin.automation_paused",
        targetType: "automation",
        targetId: req.params.automationId,
        ipAddress: req.ip,
        userAgent: req.get("user-agent"),
        metadata: { keyword: result.rows[0].keyword }
      });

      return res.json({ automation: result.rows[0] });
    } catch (error) {
      console.error("Admin automation pause failed:", error.message);
      return res.sendStatus(500);
    }
  }
);

router.post(
  "/errors/:source/:commentId/retry",
  async (req, res) => {
    try {
      const source = String(req.params.source);
      if (!["dm", "public_reply"].includes(source)) {
        return res.status(400).json({ error: "invalid_retry_source" });
      }

      const result = await pool.query(
        `SELECT
           pc.comment_id,pc.instagram_media_id,pc.commenter_id,
           pc.commenter_username,pc.comment_text,
           ia.professional_account_id,
           latest.workspace_id,
           dl.status AS dm_status,
           pr.status AS public_reply_status
         FROM processed_comments pc
         JOIN instagram_accounts ia ON ia.id=pc.instagram_account_id
         JOIN LATERAL (
           SELECT ic.workspace_id
           FROM instagram_connections ic
           WHERE ic.instagram_account_id=ia.id
           ORDER BY ic.connected_at DESC,ic.created_at DESC
           LIMIT 1
         ) latest ON TRUE
         LEFT JOIN dm_logs dl ON dl.comment_id=pc.comment_id
         LEFT JOIN public_reply_logs pr ON pr.comment_id=pc.comment_id
         WHERE pc.comment_id=$1
         LIMIT 1`,
        [req.params.commentId]
      );

      const row = result.rows[0];
      if (!row) {
        return res.status(404).json({ error: "failed_delivery_not_found" });
      }
      if (source === "dm" && row.dm_status !== "failed") {
        return res.status(409).json({ error: "dm_not_failed" });
      }
      if (source === "public_reply" && row.public_reply_status !== "failed") {
        return res.status(409).json({ error: "public_reply_not_failed" });
      }

      const nonce = Date.now();
      if (source === "dm") {
        await instagramQueue.add(
          "instagram-comment",
          {
            professionalAccountId: row.professional_account_id,
            value: {
              id: row.comment_id,
              media: { id: row.instagram_media_id },
              from: {
                id: row.commenter_id,
                username: row.commenter_username
              },
              text: row.comment_text || ""
            }
          },
          { jobId: `admin-retry-dm-${row.comment_id}-${nonce}` }
        );
      } else {
        await instagramQueue.add(
          "instagram-public-reply",
          {
            commentId: row.comment_id,
            professionalAccountId: row.professional_account_id
          },
          { jobId: `admin-retry-reply-${row.comment_id}-${nonce}` }
        );
      }

      await safeAuditLog({
        workspaceId: row.workspace_id,
        userId: req.auth.userId,
        eventType: "admin.delivery_retry_queued",
        targetType: source,
        targetId: row.comment_id,
        ipAddress: req.ip,
        userAgent: req.get("user-agent"),
        metadata: { source }
      });

      return res.json({
        queued: true,
        source,
        commentId: row.comment_id
      });
    } catch (error) {
      console.error("Admin delivery retry failed:", error.message);
      return res.sendStatus(500);
    }
  }
);

module.exports = router;
