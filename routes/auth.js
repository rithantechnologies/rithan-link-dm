const express = require("express");
const crypto = require("crypto");

const pool = require("../db");

const {
  hashPassword,
  verifyPassword
} = require("../lib/password");

const {
  COOKIE_NAME,
  hashSessionToken,
  getSessionToken,
  requireAuth
} = require("../lib/auth");

const {
  getLoginLimitStatus,
  recordLoginFailure,
  clearLoginFailures
} = require("../lib/login-rate-limit");


const {
  requireSameOrigin
} = require("../lib/same-origin");


const {
  enforceActiveSessionLimit
} = require("../lib/session-maintenance");


const {
  safeAuditLog
} = require("../lib/audit-log");

const {
  sessionMetadata
} = require("../lib/session-device");

const router =
  express.Router();

router.use(requireSameOrigin);

const SESSION_DAYS =
  Number(
    process.env.SESSION_DAYS || 30
  );

function cookieSecure() {
  return (
    process.env.SESSION_COOKIE_SECURE !==
    "false"
  );
}

function cookieOptions() {
  return {
    httpOnly: true,
    secure: cookieSecure(),
    sameSite: "lax",
    path: "/",
    maxAge:
      SESSION_DAYS *
      24 *
      60 *
      60 *
      1000
  };
}


// --------------------------------------------------
// POST /api/auth/login
// --------------------------------------------------

router.post(
  "/login",

  async (req, res) => {
    try {
      const email =
        String(req.body?.email || "")
          .trim()
          .toLowerCase();

      const password =
        String(
          req.body?.password || ""
        );

      if (!email || !password) {
        return res.status(400).json({
          error:
            "email_and_password_required"
        });
      }



      const clientIp =
        req.ip ||
        req.socket?.remoteAddress ||
        "unknown";

      const limitStatus =
        await getLoginLimitStatus(
          email,
          clientIp
        );

      if (limitStatus.limited) {
        const retryAfter =
          Math.max(
            limitStatus.retryAfterSeconds || 1,
            1
          );

        res.set(
          "Retry-After",
          String(retryAfter)
        );

        return res.status(429).json({
          error:
            "too_many_login_attempts",

          retryAfterSeconds:
            retryAfter
        });
      }
      const userResult =
        await pool.query(
          `
          SELECT
            id,
            email,
            password_hash,
            display_name

          FROM users

          WHERE
            LOWER(email) = LOWER($1)
            AND status = 'active'

          LIMIT 1
          `,
          [email]
        );



      if (
        userResult.rowCount === 0
      ) {
        const failureUnknownUser =
          await recordLoginFailure(
            email,
            clientIp
          );

        if (failureUnknownUser.limited) {
          const retryAfter =
            Math.max(
              failureUnknownUser.retryAfterSeconds || 1,
              1
            );

          res.set(
            "Retry-After",
            String(retryAfter)
          );

          return res.status(429).json({
            error:
              "too_many_login_attempts",

            retryAfterSeconds:
              retryAfter
          });
        }

        return res.status(401).json({
          error:
            "invalid_credentials"
        });
      }

      const user =
        userResult.rows[0];

      const valid =
        await verifyPassword(
          password,
          user.password_hash
        );



      if (!valid) {
        const failureInvalidPassword =
          await recordLoginFailure(
            email,
            clientIp
          );

        if (failureInvalidPassword.limited) {
          const retryAfter =
            Math.max(
              failureInvalidPassword.retryAfterSeconds || 1,
              1
            );

          res.set(
            "Retry-After",
            String(retryAfter)
          );

          return res.status(429).json({
            error:
              "too_many_login_attempts",

            retryAfterSeconds:
              retryAfter
          });
        }

        return res.status(401).json({
          error:
            "invalid_credentials"
        });
      }

      await clearLoginFailures(
        email,
        clientIp
      );

      const membership =
        await pool.query(
          `
          SELECT
            w.id,
            w.name,
            wm.role

          FROM workspace_members wm

          JOIN workspaces w
            ON w.id =
               wm.workspace_id

          WHERE
            wm.user_id = $1
            AND w.status = 'active'

          ORDER BY
            CASE wm.role
              WHEN 'owner' THEN 1
              WHEN 'admin' THEN 2
              ELSE 3
            END,
            wm.created_at ASC

          LIMIT 1
          `,
          [user.id]
        );

      if (
        membership.rowCount === 0
      ) {
        return res.status(403).json({
          error:
            "no_active_workspace"
        });
      }

      const workspace =
        membership.rows[0];

      const rawToken =
        crypto
          .randomBytes(32)
          .toString("base64url");

      const tokenHash =
        hashSessionToken(
          rawToken
        );

      const sessionInfo =
        sessionMetadata(req);

      await pool.query(
        `
        INSERT INTO user_sessions (
          user_id,
          active_workspace_id,
          session_token_hash,
          expires_at,
          user_agent,
          ip_address,
          device_label
        )
        VALUES (
          $1,
          $2,
          $3,
          NOW() +
            ($4::double precision *
             INTERVAL '1 day'),
          $5,
          $6,
          $7
        )
        `,
        [
          user.id,
          workspace.id,
          tokenHash,
          SESSION_DAYS,
          sessionInfo.userAgent,
          sessionInfo.ipAddress,
          sessionInfo.deviceLabel
        ]
      );

      try {
        await enforceActiveSessionLimit(
          pool,
          user.id
        );
      } catch (limitError) {
        console.error(
          "Session limit enforcement failed:",
          limitError.message
        );
      }



      res.cookie(
        COOKIE_NAME,
        rawToken,
        cookieOptions()
      );

      

      await safeAuditLog({
        workspaceId:
          workspace.id,

        userId:
          user.id,

        eventType:
          "auth.login_success",

        targetType:
          "user",

        targetId:
          user.id,

        ipAddress:
          clientIp,

        userAgent:
          req.get("user-agent"),

        metadata: {
          email:
            user.email
        }
      });


return res.json({
        user: {
          id:
            user.id,

          email:
            user.email,

          displayName:
            user.display_name
        },

        workspace: {
          id:
            workspace.id,

          name:
            workspace.name,

          role:
            workspace.role
        }
      });

    } catch (error) {
      console.error(
        "Login failed:",
        error.message
      );

      return res.sendStatus(500);
    }
  }
);


// --------------------------------------------------
// GET /api/auth/me
// --------------------------------------------------

router.get(
  "/me",
  requireAuth,

  (req, res) => {
    return res.json({
      user: {
        id:
          req.auth.userId,

        email:
          req.auth.email,

        displayName:
          req.auth.displayName,

        isSystemAdmin:
          req.auth.isSystemAdmin ===
          true
      },

      workspace: {
        id:
          req.auth.workspaceId,

        name:
          req.auth.workspaceName,

        role:
          req.auth.role
      }
    });
  }
);


// --------------------------------------------------
// GET /api/auth/sessions
// --------------------------------------------------

router.get(
  "/sessions",
  requireAuth,

  async (req, res) => {
    try {
      const result =
        await pool.query(
          `
          SELECT
            id,
            created_at,
            last_seen_at,
            expires_at,
            device_label,
            ip_address,
            user_agent,

            (
              id = $2
            ) AS is_current

          FROM user_sessions

          WHERE
            user_id = $1
            AND revoked_at IS NULL
            AND expires_at > NOW()

          ORDER BY
            is_current DESC,
            last_seen_at DESC
          `,
          [
            req.auth.userId,
            req.auth.sessionId
          ]
        );

      return res.json({
        sessions:
          result.rows
      });

    } catch (error) {
      console.error(
        "List sessions failed:",
        error.message
      );

      return res.sendStatus(500);
    }
  }
);


// --------------------------------------------------
// POST /api/auth/change-password
// --------------------------------------------------

router.post(
  "/change-password",
  requireAuth,

  async (req, res) => {
    try {
      const currentPassword =
        String(
          req.body
            ?.currentPassword || ""
        );

      const newPassword =
        String(
          req.body
            ?.newPassword || ""
        );

      if (
        !currentPassword ||
        !newPassword
      ) {
        return res.status(400).json({
          error:
            "current_and_new_password_required"
        });
      }

      if (
        newPassword.length < 12
      ) {
        return res.status(400).json({
          error:
            "password_too_short"
        });
      }

      if (
        currentPassword ===
        newPassword
      ) {
        return res.status(400).json({
          error:
            "password_must_change"
        });
      }

      const userResult =
        await pool.query(
          `
          SELECT password_hash
          FROM users
          WHERE id = $1
          LIMIT 1
          `,
          [
            req.auth.userId
          ]
        );

      const valid =
        await verifyPassword(
          currentPassword,
          userResult.rows[0]
            ?.password_hash
        );

      if (!valid) {
        return res.status(401).json({
          error:
            "current_password_incorrect"
        });
      }

      const passwordHash =
        await hashPassword(
          newPassword
        );

      const client =
        await pool.connect();

      let revokedOtherSessions = 0;

      try {
        await client.query(
          "BEGIN"
        );

        await client.query(
          `
          UPDATE users
          SET
            password_hash = $1,
            updated_at = NOW()
          WHERE id = $2
          `,
          [
            passwordHash,
            req.auth.userId
          ]
        );

        const revoked =
          await client.query(
            `
            UPDATE user_sessions
            SET revoked_at = NOW()
            WHERE
              user_id = $1
              AND id <> $2
              AND revoked_at IS NULL
            `,
            [
              req.auth.userId,
              req.auth.sessionId
            ]
          );

        revokedOtherSessions =
          revoked.rowCount;

        await client.query(
          "COMMIT"
        );

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

      await safeAuditLog({
        workspaceId:
          req.auth.workspaceId,

        userId:
          req.auth.userId,

        eventType:
          "auth.password_changed",

        targetType:
          "user",

        targetId:
          req.auth.userId,

        ipAddress:
          req.ip,

        userAgent:
          req.get(
            "user-agent"
          ),

        metadata: {
          revokedOtherSessions
        }
      });

      return res.json({
        changed: true,
        revokedOtherSessions
      });

    } catch (error) {
      console.error(
        "Change password failed:",
        error.message
      );

      return res.sendStatus(500);
    }
  }
);


// --------------------------------------------------
// POST /api/auth/sessions/:id/revoke
// --------------------------------------------------

router.post(
  "/sessions/:id/revoke",
  requireAuth,

  async (req, res) => {
    try {
      if (req.params.id === req.auth.sessionId) {
        return res.status(400).json({
          error: "cannot_revoke_current_session"
        });
      }

      const result = await pool.query(
        `
        UPDATE user_sessions
        SET revoked_at = NOW()
        WHERE
          id = $1
          AND user_id = $2
          AND revoked_at IS NULL
        RETURNING id
        `,
        [
          req.params.id,
          req.auth.userId
        ]
      );

      if (result.rowCount === 0) {
        return res.status(404).json({
          error: "session_not_found"
        });
      }

      await safeAuditLog({
        workspaceId: req.auth.workspaceId,
        userId: req.auth.userId,
        eventType: "auth.session_revoked",
        targetType: "user_session",
        targetId: req.params.id,
        ipAddress: req.ip,
        userAgent: req.get("user-agent")
      });

      return res.json({
        revoked: true,
        sessionId: req.params.id
      });
    } catch (error) {
      console.error(
        "Revoke session failed:",
        error.message
      );
      return res.sendStatus(500);
    }
  }
);


// --------------------------------------------------
// POST /api/auth/sessions/revoke-others
// --------------------------------------------------

router.post(
  "/sessions/revoke-others",
  requireAuth,

  async (req, res) => {
    try {
      const result =
        await pool.query(
          `
          UPDATE user_sessions
          SET revoked_at = NOW()
          WHERE
            user_id = $1
            AND id <> $2
            AND revoked_at IS NULL
          `,
          [
            req.auth.userId,
            req.auth.sessionId
          ]
        );

      await safeAuditLog({
        workspaceId:
          req.auth.workspaceId,

        userId:
          req.auth.userId,

        eventType:
          "auth.sessions_revoked",

        targetType:
          "user",

        targetId:
          req.auth.userId,

        ipAddress:
          req.ip,

        userAgent:
          req.get(
            "user-agent"
          ),

        metadata: {
          revokedSessions:
            result.rowCount
        }
      });

      return res.json({
        revokedSessions:
          result.rowCount
      });

    } catch (error) {
      console.error(
        "Revoke sessions failed:",
        error.message
      );

      return res.sendStatus(500);
    }
  }
);


// --------------------------------------------------
// POST /api/auth/logout
// --------------------------------------------------

router.post(
  "/logout",

  async (req, res) => {
    try {
      const token =
        getSessionToken(req);

      let revokedSession =
        null;

      if (token) {
        const result =
          await pool.query(
            `
            UPDATE user_sessions

            SET revoked_at = NOW()

            WHERE
              session_token_hash = $1
              AND revoked_at IS NULL

            RETURNING
              user_id,
              active_workspace_id
            `,
            [
              hashSessionToken(
                token
              )
            ]
          );

        revokedSession =
          result.rows[0] || null;
      }

      res.clearCookie(
        COOKIE_NAME,
        {
          httpOnly: true,
          secure:
            cookieSecure(),
          sameSite: "lax",
          path: "/"
        }
      );

      if (revokedSession) {
        await safeAuditLog({
          workspaceId:
            revokedSession
              .active_workspace_id,

          userId:
            revokedSession.user_id,

          eventType:
            "auth.logout",

          targetType:
            "user",

          targetId:
            revokedSession.user_id,

          ipAddress:
            req.ip,

          userAgent:
            req.get(
              "user-agent"
            ),

          metadata: {}
        });
      }

      return res.json({
        loggedOut: true
      });

    } catch (error) {
      console.error(
        "Logout failed:",
        error.message
      );

      return res.sendStatus(500);
    }
  }
);

module.exports = router;
