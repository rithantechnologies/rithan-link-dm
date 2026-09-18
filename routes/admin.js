const express = require("express");
const crypto = require("crypto");

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

function setupTokenHash(token) {
  return crypto
    .createHash("sha256")
    .update(String(token || ""))
    .digest("hex");
}

function setupUrl(token) {
  const base =
    process.env.PUBLIC_API_URL ||
    "https://api.rithantechnologies.com";

  const url =
    new URL(
      "/dashboard/",
      base
    );

  url.hash =
    `setup=${encodeURIComponent(token)}`;

  return url.toString();
}

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
            ) AS tokens_expiring_14d,

            (
              SELECT COUNT(*)::integer
              FROM customer_access_requests
              WHERE status = 'pending'
            ) AS pending_customer_requests
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
  "/customer-requests",
  async (req, res) => {
    try {
      const status =
        String(req.query.status || "pending")
          .trim()
          .toLowerCase();

      const allowed =
        ["pending", "approved", "rejected", "all"];

      if (!allowed.includes(status)) {
        return res.status(400).json({
          error: "invalid_request_status"
        });
      }

      const limit =
        limitValue(req.query.limit, 100, 200);

      const params = [];
      let where = "";

      if (status !== "all") {
        params.push(status);
        where = `WHERE car.status=$${params.length}`;
      }

      params.push(limit);

      const result =
        await pool.query(
          `
          SELECT
            car.id,
            car.email,
            car.display_name,
            car.workspace_name,
            car.use_case,
            car.status,
            car.created_at,
            car.updated_at,
            car.reviewed_at,
            car.rejection_reason,
            car.provisioned_workspace_id,
            car.provisioned_user_id,
            reviewer.email AS reviewer_email,
            u.status AS user_status,
            EXISTS (
              SELECT 1
              FROM account_setup_tokens ast
              WHERE
                ast.user_id=car.provisioned_user_id
                AND ast.consumed_at IS NULL
                AND ast.expires_at>NOW()
            ) AS setup_pending
          FROM customer_access_requests car
          LEFT JOIN users reviewer
            ON reviewer.id=car.reviewed_by_user_id
          LEFT JOIN users u
            ON u.id=car.provisioned_user_id
          ${where}
          ORDER BY
            CASE car.status
              WHEN 'pending' THEN 1
              WHEN 'approved' THEN 2
              ELSE 3
            END,
            car.created_at DESC
          LIMIT $${params.length}
          `,
          params
        );

      return res.json({
        requests: result.rows
      });
    } catch (error) {
      console.error(
        "Customer requests lookup failed:",
        error.message
      );
      return res.sendStatus(500);
    }
  }
);

router.post(
  "/customer-requests/:id/approve",
  async (req, res) => {
    const planCode =
      String(req.body?.planCode || "free")
        .trim()
        .toLowerCase();

    const rawToken =
      crypto.randomBytes(32).toString("base64url");

    const setupHours =
      Math.max(
        1,
        Math.min(
          Number(process.env.ACCOUNT_SETUP_HOURS || 72),
          168
        )
      );

    const client =
      await pool.connect();

    try {
      await client.query("BEGIN");

      const requestResult =
        await client.query(
          `
          SELECT *
          FROM customer_access_requests
          WHERE id=$1
          FOR UPDATE
          `,
          [req.params.id]
        );

      if (!requestResult.rowCount) {
        await client.query("ROLLBACK");
        return res.status(404).json({
          error: "customer_request_not_found"
        });
      }

      const request =
        requestResult.rows[0];

      if (request.status !== "pending") {
        await client.query("ROLLBACK");
        return res.status(409).json({
          error: "customer_request_already_reviewed"
        });
      }

      const plan =
        await client.query(
          `SELECT code FROM plans
           WHERE code=$1 AND is_active=TRUE
           LIMIT 1`,
          [planCode]
        );

      if (!plan.rowCount) {
        await client.query("ROLLBACK");
        return res.status(400).json({
          error: "invalid_plan"
        });
      }

      const existingUser =
        await client.query(
          `SELECT id,status FROM users
           WHERE LOWER(email)=LOWER($1)
           LIMIT 1`,
          [request.email]
        );

      if (existingUser.rowCount) {
        await client.query("ROLLBACK");
        return res.status(409).json({
          error: "email_already_registered"
        });
      }

      const workspace =
        await client.query(
          `
          INSERT INTO workspaces (name,status)
          VALUES ($1,'active')
          RETURNING id,name,status,created_at
          `,
          [request.workspace_name]
        );

      const user =
        await client.query(
          `
          INSERT INTO users (
            email,password_hash,display_name,status
          )
          VALUES ($1,NULL,$2,'disabled')
          RETURNING id,email,display_name,status
          `,
          [
            request.email,
            request.display_name || null
          ]
        );

      const workspaceId = workspace.rows[0].id;
      const userId = user.rows[0].id;

      await client.query(
        `
        INSERT INTO workspace_members (
          workspace_id,user_id,role
        )
        VALUES ($1,$2,'owner')
        `,
        [workspaceId,userId]
      );

      await client.query(
        `
        INSERT INTO workspace_subscriptions (
          workspace_id,
          plan_code,
          status,
          current_period_start,
          current_period_end
        )
        VALUES (
          $1,$2,'active',
          date_trunc('month',NOW()),
          date_trunc('month',NOW()) + INTERVAL '1 month'
        )
        `,
        [workspaceId,planCode]
      );

      await client.query(
        `
        INSERT INTO workspace_usage_monthly (
          workspace_id,period_start,dm_sent_count
        )
        VALUES (
          $1,
          date_trunc('month',NOW())::date,
          0
        )
        `,
        [workspaceId]
      );

      const setup =
        await client.query(
          `
          INSERT INTO account_setup_tokens (
            user_id,
            workspace_id,
            token_hash,
            expires_at,
            created_by_user_id
          )
          VALUES (
            $1,$2,$3,
            NOW() + ($4::double precision * INTERVAL '1 hour'),
            $5
          )
          RETURNING expires_at
          `,
          [
            userId,
            workspaceId,
            setupTokenHash(rawToken),
            setupHours,
            req.auth.userId
          ]
        );

      await client.query(
        `
        UPDATE customer_access_requests
        SET
          status='approved',
          reviewed_by_user_id=$1,
          reviewed_at=NOW(),
          provisioned_workspace_id=$2,
          provisioned_user_id=$3,
          updated_at=NOW()
        WHERE id=$4
        `,
        [
          req.auth.userId,
          workspaceId,
          userId,
          request.id
        ]
      );

      await client.query("COMMIT");

      await safeAuditLog({
        workspaceId,
        userId: req.auth.userId,
        eventType: "admin.customer_approved",
        targetType: "customer_access_request",
        targetId: request.id,
        ipAddress: req.ip,
        userAgent: req.get("user-agent"),
        metadata: {
          customerEmail: request.email,
          ownerUserId: userId,
          planCode
        }
      });

      return res.json({
        approved: true,
        workspace: workspace.rows[0],
        owner: user.rows[0],
        planCode,
        setupUrl: setupUrl(rawToken),
        setupExpiresAt: setup.rows[0].expires_at
      });
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {}

      console.error(
        "Customer approval failed:",
        error.message
      );
      return res.sendStatus(500);
    } finally {
      client.release();
    }
  }
);

router.post(
  "/customer-requests/:id/reject",
  async (req, res) => {
    try {
      const reason =
        String(req.body?.reason || "")
          .trim()
          .slice(0, 1000);

      const result =
        await pool.query(
          `
          UPDATE customer_access_requests
          SET
            status='rejected',
            reviewed_by_user_id=$1,
            reviewed_at=NOW(),
            rejection_reason=$2,
            updated_at=NOW()
          WHERE id=$3 AND status='pending'
          RETURNING id,email,workspace_name,status
          `,
          [
            req.auth.userId,
            reason || null,
            req.params.id
          ]
        );

      if (!result.rowCount) {
        return res.status(404).json({
          error: "pending_customer_request_not_found"
        });
      }

      await safeAuditLog({
        workspaceId: null,
        userId: req.auth.userId,
        eventType: "admin.customer_rejected",
        targetType: "customer_access_request",
        targetId: result.rows[0].id,
        ipAddress: req.ip,
        userAgent: req.get("user-agent"),
        metadata: {
          customerEmail: result.rows[0].email,
          workspaceName: result.rows[0].workspace_name,
          reason: reason || null
        }
      });

      return res.json({
        rejected: true,
        request: result.rows[0]
      });
    } catch (error) {
      console.error(
        "Customer rejection failed:",
        error.message
      );
      return res.sendStatus(500);
    }
  }
);

router.post(
  "/customer-requests/:id/setup-link",
  async (req, res) => {
    const rawToken =
      crypto.randomBytes(32).toString("base64url");

    const setupHours =
      Math.max(
        1,
        Math.min(
          Number(process.env.ACCOUNT_SETUP_HOURS || 72),
          168
        )
      );

    const client =
      await pool.connect();

    try {
      await client.query("BEGIN");

      const result =
        await client.query(
          `
          SELECT
            car.id,
            car.email,
            car.provisioned_user_id AS user_id,
            car.provisioned_workspace_id AS workspace_id,
            u.status AS user_status
          FROM customer_access_requests car
          JOIN users u
            ON u.id=car.provisioned_user_id
          WHERE
            car.id=$1
            AND car.status='approved'
          FOR UPDATE OF car,u
          `,
          [req.params.id]
        );

      if (!result.rowCount) {
        await client.query("ROLLBACK");
        return res.status(404).json({
          error: "approved_customer_request_not_found"
        });
      }

      const row = result.rows[0];

      if (row.user_status === "active") {
        await client.query("ROLLBACK");
        return res.status(409).json({
          error: "account_already_activated"
        });
      }

      await client.query(
        `
        UPDATE account_setup_tokens
        SET consumed_at=COALESCE(consumed_at,NOW())
        WHERE
          user_id=$1
          AND consumed_at IS NULL
        `,
        [row.user_id]
      );

      const setup =
        await client.query(
          `
          INSERT INTO account_setup_tokens (
            user_id,workspace_id,token_hash,
            expires_at,created_by_user_id
          )
          VALUES (
            $1,$2,$3,
            NOW() + ($4::double precision * INTERVAL '1 hour'),
            $5
          )
          RETURNING expires_at
          `,
          [
            row.user_id,
            row.workspace_id,
            setupTokenHash(rawToken),
            setupHours,
            req.auth.userId
          ]
        );

      await client.query("COMMIT");

      await safeAuditLog({
        workspaceId: row.workspace_id,
        userId: req.auth.userId,
        eventType: "admin.account_setup_link_reissued",
        targetType: "user",
        targetId: row.user_id,
        ipAddress: req.ip,
        userAgent: req.get("user-agent"),
        metadata: {
          customerEmail: row.email
        }
      });

      return res.json({
        setupUrl: setupUrl(rawToken),
        setupExpiresAt: setup.rows[0].expires_at
      });
    } catch (error) {
      try {
        await client.query("ROLLBACK");
      } catch {}
      console.error(
        "Setup link regeneration failed:",
        error.message
      );
      return res.sendStatus(500);
    } finally {
      client.release();
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
