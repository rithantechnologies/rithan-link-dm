const express = require("express");
const crypto = require("crypto");
const pool = require("../db");
const { requireAuth } = require("../lib/auth");
const { requireSameOrigin } = require("../lib/same-origin");
const {
  requireWorkspaceEditor,
  requireWorkspaceOwner
} = require("../lib/workspace-policy");
const { safeAuditLog } = require("../lib/audit-log");

const router = express.Router();
router.use(requireAuth);
router.use(requireSameOrigin);

function cleanEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function validTimezone(value) {
  try {
    Intl.DateTimeFormat("en", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

function inviteTokenHash(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

router.get("/", async (req, res) => {
  try {
    const [workspace, members, invitations, notifications] = await Promise.all([
      pool.query(
        `SELECT id,name,status,timezone,notification_email,
                notify_token_expiry,notify_failures,created_at,updated_at
         FROM workspaces WHERE id=$1 LIMIT 1`,
        [req.auth.workspaceId]
      ),
      pool.query(
        `SELECT u.id,u.email,u.display_name,u.status,wm.role,wm.created_at
         FROM workspace_members wm JOIN users u ON u.id=wm.user_id
         WHERE wm.workspace_id=$1
         ORDER BY CASE wm.role WHEN 'owner' THEN 1 WHEN 'admin' THEN 2 ELSE 3 END,
                  wm.created_at ASC`,
        [req.auth.workspaceId]
      ),
      pool.query(
        `SELECT id,email,role,expires_at,created_at
         FROM workspace_invitations
         WHERE workspace_id=$1 AND accepted_at IS NULL
           AND revoked_at IS NULL AND expires_at>NOW()
         ORDER BY created_at DESC`,
        [req.auth.workspaceId]
      ),
      pool.query(
        `SELECT id,notification_type,severity,title,message,action_url,read_at,created_at
         FROM workspace_notifications
         WHERE workspace_id=$1
         ORDER BY (read_at IS NULL) DESC, created_at DESC
         LIMIT 50`,
        [req.auth.workspaceId]
      )
    ]);

    return res.json({
      workspace: workspace.rows[0] || null,
      members: members.rows,
      invitations: ["owner","admin"].includes(req.auth.role)
        ? invitations.rows
        : [],
      notifications: notifications.rows,
      permissions: {
        editWorkspace: ["owner","admin"].includes(req.auth.role),
        inviteMembers: ["owner","admin"].includes(req.auth.role),
        manageRoles: req.auth.role === "owner"
      }
    });
  } catch (error) {
    console.error("Settings load failed:", error.message);
    return res.sendStatus(500);
  }
});

router.patch(
  "/workspace",
  requireWorkspaceEditor,
  async (req, res) => {
    try {
      const name = String(req.body?.name || "").trim();
      const timezone = String(req.body?.timezone || "UTC").trim();
      const notificationEmail = cleanEmail(req.body?.notificationEmail);
      const notifyTokenExpiry = req.body?.notifyTokenExpiry !== false;
      const notifyFailures = req.body?.notifyFailures !== false;

      if (!name || name.length > 120) {
        return res.status(400).json({ error: "invalid_workspace_name" });
      }
      if (!validTimezone(timezone)) {
        return res.status(400).json({ error: "invalid_timezone" });
      }
      if (notificationEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(notificationEmail)) {
        return res.status(400).json({ error: "invalid_notification_email" });
      }

      const result = await pool.query(
        `UPDATE workspaces
         SET name=$1, timezone=$2, notification_email=$3,
             notify_token_expiry=$4, notify_failures=$5, updated_at=NOW()
         WHERE id=$6
         RETURNING id,name,status,timezone,notification_email,
                   notify_token_expiry,notify_failures,updated_at`,
        [
          name,
          timezone,
          notificationEmail || null,
          notifyTokenExpiry,
          notifyFailures,
          req.auth.workspaceId
        ]
      );

      await safeAuditLog({
        workspaceId: req.auth.workspaceId,
        userId: req.auth.userId,
        eventType: "workspace.settings_updated",
        targetType: "workspace",
        targetId: req.auth.workspaceId,
        ipAddress: req.ip,
        userAgent: req.get("user-agent"),
        metadata: {
          timezone,
          notificationEmail: notificationEmail || null,
          notifyTokenExpiry,
          notifyFailures
        }
      });

      return res.json({ workspace: result.rows[0] });
    } catch (error) {
      console.error("Workspace settings update failed:", error.message);
      return res.sendStatus(500);
    }
  }
);

router.post("/notifications/:id/read", async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE workspace_notifications
       SET read_at=COALESCE(read_at,NOW())
       WHERE id=$1 AND workspace_id=$2
       RETURNING id,read_at`,
      [req.params.id, req.auth.workspaceId]
    );
    if (!result.rowCount) {
      return res.status(404).json({ error: "notification_not_found" });
    }
    return res.json({ notification: result.rows[0] });
  } catch (error) {
    console.error("Notification read failed:", error.message);
    return res.sendStatus(500);
  }
});

router.post(
  "/team/invitations",
  requireWorkspaceEditor,
  async (req, res) => {
    try {
      const email = cleanEmail(req.body?.email);
      const role = String(req.body?.role || "member").toLowerCase();

      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        return res.status(400).json({ error: "invalid_email" });
      }
      if (!["admin","member"].includes(role)) {
        return res.status(400).json({ error: "invalid_role" });
      }
      if (req.auth.role !== "owner" && role !== "member") {
        return res.status(403).json({ error: "owner_required_for_admin_invite" });
      }

      const existing = await pool.query(
        `SELECT 1 FROM workspace_members wm
         JOIN users u ON u.id=wm.user_id
         WHERE wm.workspace_id=$1 AND LOWER(u.email)=LOWER($2)
         LIMIT 1`,
        [req.auth.workspaceId, email]
      );
      if (existing.rowCount) {
        return res.status(409).json({ error: "already_workspace_member" });
      }

      await pool.query(
        `UPDATE workspace_invitations SET revoked_at=NOW()
         WHERE workspace_id=$1 AND LOWER(email)=LOWER($2)
           AND accepted_at IS NULL AND revoked_at IS NULL`,
        [req.auth.workspaceId, email]
      );

      const token = crypto.randomBytes(32).toString("base64url");
      const result = await pool.query(
        `INSERT INTO workspace_invitations
         (workspace_id,email,role,token_hash,invited_by_user_id,expires_at)
         VALUES ($1,$2,$3,$4,$5,NOW()+INTERVAL '7 days')
         RETURNING id,email,role,expires_at,created_at`,
        [
          req.auth.workspaceId,
          email,
          role,
          inviteTokenHash(token),
          req.auth.userId
        ]
      );

      await safeAuditLog({
        workspaceId: req.auth.workspaceId,
        userId: req.auth.userId,
        eventType: "workspace.invitation_created",
        targetType: "workspace_invitation",
        targetId: result.rows[0].id,
        ipAddress: req.ip,
        userAgent: req.get("user-agent"),
        metadata: { email, role }
      });

      return res.status(201).json({
        invitation: result.rows[0],
        inviteUrl: `/dashboard/?invite=${encodeURIComponent(token)}`
      });
    } catch (error) {
      console.error("Create invitation failed:", error.message);
      return res.sendStatus(500);
    }
  }
);

router.delete(
  "/team/invitations/:id",
  requireWorkspaceEditor,
  async (req, res) => {
    try {
      const result = await pool.query(
        `UPDATE workspace_invitations
         SET revoked_at=NOW()
         WHERE id=$1 AND workspace_id=$2
           AND accepted_at IS NULL AND revoked_at IS NULL
         RETURNING id,email,role`,
        [req.params.id, req.auth.workspaceId]
      );
      if (!result.rowCount) {
        return res.status(404).json({ error: "invitation_not_found" });
      }

      await safeAuditLog({
        workspaceId: req.auth.workspaceId,
        userId: req.auth.userId,
        eventType: "workspace.invitation_revoked",
        targetType: "workspace_invitation",
        targetId: req.params.id,
        ipAddress: req.ip,
        userAgent: req.get("user-agent"),
        metadata: {
          email: result.rows[0].email,
          role: result.rows[0].role
        }
      });

      return res.json({ revoked: true });
    } catch (error) {
      console.error("Revoke invitation failed:", error.message);
      return res.sendStatus(500);
    }
  }
);

router.patch(
  "/team/members/:userId",
  requireWorkspaceOwner,
  async (req, res) => {
    try {
      const role = String(req.body?.role || "").toLowerCase();
      if (!["admin","member"].includes(role)) {
        return res.status(400).json({ error: "invalid_role" });
      }

      const current = await pool.query(
        `SELECT wm.role,u.email
         FROM workspace_members wm JOIN users u ON u.id=wm.user_id
         WHERE wm.workspace_id=$1 AND wm.user_id=$2 LIMIT 1`,
        [req.auth.workspaceId, req.params.userId]
      );
      if (!current.rowCount) {
        return res.status(404).json({ error: "workspace_member_not_found" });
      }
      if (current.rows[0].role === "owner") {
        return res.status(409).json({ error: "owner_role_cannot_be_changed_here" });
      }

      const updated = await pool.query(
        `UPDATE workspace_members SET role=$1
         WHERE workspace_id=$2 AND user_id=$3
         RETURNING user_id,role`,
        [role, req.auth.workspaceId, req.params.userId]
      );

      await safeAuditLog({
        workspaceId: req.auth.workspaceId,
        userId: req.auth.userId,
        eventType: "workspace.member_role_changed",
        targetType: "user",
        targetId: req.params.userId,
        ipAddress: req.ip,
        userAgent: req.get("user-agent"),
        metadata: {
          from: current.rows[0].role,
          to: role,
          email: current.rows[0].email
        }
      });

      return res.json({ member: updated.rows[0] });
    } catch (error) {
      console.error("Member role update failed:", error.message);
      return res.sendStatus(500);
    }
  }
);

router.delete(
  "/team/members/:userId",
  requireWorkspaceEditor,
  async (req, res) => {
    try {
      const current = await pool.query(
        `SELECT wm.role,u.email
         FROM workspace_members wm JOIN users u ON u.id=wm.user_id
         WHERE wm.workspace_id=$1 AND wm.user_id=$2 LIMIT 1`,
        [req.auth.workspaceId, req.params.userId]
      );
      if (!current.rowCount) {
        return res.status(404).json({ error: "workspace_member_not_found" });
      }
      const targetRole = current.rows[0].role;
      if (targetRole === "owner") {
        return res.status(409).json({ error: "owner_cannot_be_removed" });
      }
      if (req.params.userId === req.auth.userId) {
        return res.status(400).json({ error: "cannot_remove_self" });
      }
      if (req.auth.role !== "owner" && targetRole !== "member") {
        return res.status(403).json({ error: "owner_required" });
      }

      await pool.query(
        `DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2`,
        [req.auth.workspaceId, req.params.userId]
      );
      await pool.query(
        `UPDATE user_sessions SET revoked_at=NOW()
         WHERE user_id=$1 AND active_workspace_id=$2 AND revoked_at IS NULL`,
        [req.params.userId, req.auth.workspaceId]
      );

      await safeAuditLog({
        workspaceId: req.auth.workspaceId,
        userId: req.auth.userId,
        eventType: "workspace.member_removed",
        targetType: "user",
        targetId: req.params.userId,
        ipAddress: req.ip,
        userAgent: req.get("user-agent"),
        metadata: {
          role: targetRole,
          email: current.rows[0].email
        }
      });

      return res.json({ removed: true });
    } catch (error) {
      console.error("Remove member failed:", error.message);
      return res.sendStatus(500);
    }
  }
);

router.post("/team/invitations/accept", async (req, res) => {
  const token = String(req.body?.token || "");
  if (!token) {
    return res.status(400).json({ error: "invite_token_required" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const invitation = await client.query(
      `SELECT wi.id,wi.workspace_id,wi.email,wi.role,w.name AS workspace_name
       FROM workspace_invitations wi
       JOIN workspaces w ON w.id=wi.workspace_id
       WHERE wi.token_hash=$1
         AND wi.accepted_at IS NULL
         AND wi.revoked_at IS NULL
         AND wi.expires_at>NOW()
         AND w.status='active'
       FOR UPDATE`,
      [inviteTokenHash(token)]
    );

    if (!invitation.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "invitation_invalid_or_expired" });
    }

    const invite = invitation.rows[0];
    if (cleanEmail(invite.email) !== cleanEmail(req.auth.email)) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "invitation_email_mismatch" });
    }

    await client.query(
      `INSERT INTO workspace_members (workspace_id,user_id,role)
       VALUES ($1,$2,$3)
       ON CONFLICT (workspace_id,user_id)
       DO UPDATE SET role=EXCLUDED.role`,
      [invite.workspace_id, req.auth.userId, invite.role]
    );

    await client.query(
      `UPDATE workspace_invitations SET accepted_at=NOW() WHERE id=$1`,
      [invite.id]
    );

    await client.query(
      `UPDATE user_sessions SET active_workspace_id=$1
       WHERE id=$2 AND user_id=$3`,
      [invite.workspace_id, req.auth.sessionId, req.auth.userId]
    );

    await client.query("COMMIT");

    await safeAuditLog({
      workspaceId: invite.workspace_id,
      userId: req.auth.userId,
      eventType: "workspace.invitation_accepted",
      targetType: "workspace_invitation",
      targetId: invite.id,
      ipAddress: req.ip,
      userAgent: req.get("user-agent"),
      metadata: {
        email: invite.email,
        role: invite.role
      }
    });

    return res.json({
      accepted: true,
      workspace: {
        id: invite.workspace_id,
        name: invite.workspace_name,
        role: invite.role
      },
      reloadRequired: true
    });
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {}
    console.error("Accept invitation failed:", error.message);
    return res.sendStatus(500);
  } finally {
    client.release();
  }
});

module.exports = router;
