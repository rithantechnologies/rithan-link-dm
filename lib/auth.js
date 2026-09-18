const crypto = require("crypto");

const pool = require("../db");

const COOKIE_NAME =
  process.env.SESSION_COOKIE_NAME ||
  "rithan_session";

function hashSessionToken(token) {
  return crypto
    .createHash("sha256")
    .update(String(token))
    .digest("hex");
}

function parseCookies(req) {
  const header =
    String(req.headers.cookie || "");

  const cookies = {};

  for (const item of header.split(";")) {
    const index = item.indexOf("=");

    if (index === -1) {
      continue;
    }

    const key =
      item.slice(0, index).trim();

    const value =
      item.slice(index + 1).trim();

    if (key) {
      cookies[key] =
        decodeURIComponent(value);
    }
  }

  return cookies;
}

function getSessionToken(req) {
  const cookies =
    parseCookies(req);

  return cookies[COOKIE_NAME] || null;
}

async function requireAuth(
  req,
  res,
  next
) {
  try {
    const token =
      getSessionToken(req);

    if (!token) {
      return res.status(401).json({
        error: "authentication_required"
      });
    }

    const tokenHash =
      hashSessionToken(token);

    const result =
      await pool.query(
        `
        SELECT
          us.id AS session_id,
          us.user_id,
          us.active_workspace_id,

          u.email,
          u.display_name,

          w.name AS workspace_name,

          wm.role,

          (
            sa.user_id IS NOT NULL
          ) AS is_system_admin

        FROM user_sessions us

        JOIN users u
          ON u.id = us.user_id

        JOIN workspaces w
          ON w.id =
             us.active_workspace_id

        JOIN workspace_members wm
          ON wm.user_id =
             us.user_id
         AND wm.workspace_id =
             us.active_workspace_id

        LEFT JOIN system_admins sa
          ON sa.user_id =
             us.user_id

        WHERE
          us.session_token_hash = $1

          AND us.revoked_at IS NULL
          AND us.expires_at > NOW()

          AND u.status = 'active'
          AND w.status = 'active'

        LIMIT 1
        `,
        [tokenHash]
      );

    if (result.rowCount === 0) {
      return res.status(401).json({
        error: "invalid_or_expired_session"
      });
    }

    const row =
      result.rows[0];

    req.auth = {
      sessionId:
        row.session_id,

      userId:
        row.user_id,

      email:
        row.email,

      displayName:
        row.display_name,

      workspaceId:
        row.active_workspace_id,

      workspaceName:
        row.workspace_name,

      role:
        row.role,

      isSystemAdmin:
        row.is_system_admin === true
    };

    // Non-critical activity update.
    pool.query(
      `
      UPDATE user_sessions
      SET last_seen_at = NOW()
      WHERE id = $1
      `,
      [row.session_id]
    ).catch(() => {});

    next();

  } catch (error) {
    console.error(
      "Authentication lookup failed:",
      error.message
    );

    return res.sendStatus(500);
  }
}

module.exports = {
  COOKIE_NAME,
  hashSessionToken,
  getSessionToken,
  requireAuth
};
