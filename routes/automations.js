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
  subscriptionAllowsUsage,
  getWorkspaceEntitlements,
  getWorkspaceActiveAutomationCount
} = require("../lib/entitlements");

const router = express.Router();

// --------------------------------------------------
// Customer session authentication
// --------------------------------------------------

router.use(requireAuth);
router.use(requireSameOrigin);

function workspaceId(req) {
  return req.auth.workspaceId;
}


function cleanString(value) {
  return typeof value === "string"
    ? value.trim()
    : "";
}


function validUrl(value) {
  try {
    const url = new URL(value);

    return (
      url.protocol === "http:" ||
      url.protocol === "https:"
    );
  } catch {
    return false;
  }
}


// --------------------------------------------------
// Confirm Instagram account belongs to workspace
// using the most recent connection.
// --------------------------------------------------

async function accountBelongsToWorkspace(
  instagramAccountId,
  workspace
) {
  const result = await pool.query(
    `
    SELECT 1

    FROM instagram_accounts ia

    JOIN LATERAL (
      SELECT
        ic.workspace_id,
        ic.status

      FROM instagram_connections ic

      WHERE
        ic.instagram_account_id = ia.id

      ORDER BY
        ic.connected_at DESC,
        ic.created_at DESC

      LIMIT 1
    ) latest
      ON TRUE

    WHERE
      ia.id = $1
      AND latest.workspace_id = $2
      AND latest.status = 'connected'

    LIMIT 1
    `,
    [
      instagramAccountId,
      workspace
    ]
  );

  return result.rowCount === 1;
}


// --------------------------------------------------
// GET /api/automations
// --------------------------------------------------

router.get("/", async (req, res) => {
  try {
    const workspace =
      workspaceId(req);

    if (!workspace) {
      return res.status(400).json({
        error: "workspace_required"
      });
    }

    const result = await pool.query(
      `
      SELECT
        a.id,
        a.instagram_account_id,
        ia.username AS instagram_username,

        a.instagram_media_id,
        a.keyword,
        a.destination_url,
        a.dm_template,

        a.public_reply_enabled,
        a.public_reply_template,

        a.match_mode,
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
        a.created_at DESC
      `,
      [workspace]
    );

    return res.json({
      automations: result.rows
    });

  } catch (error) {
    console.error(
      "List automations failed:",
      error.message
    );

    return res.sendStatus(500);
  }
});


// --------------------------------------------------
// POST /api/automations
// --------------------------------------------------

router.post("/", async (req, res) => {
  try {
    const workspace =
      workspaceId(req);

    const instagramAccountId =
      cleanString(
        req.body.instagramAccountId
      );

    const instagramMediaId =
      cleanString(
        req.body.instagramMediaId
      );

    const keyword =
      cleanString(
        req.body.keyword
      );

    const destinationUrl =
      cleanString(
        req.body.destinationUrl
      );

    const dmTemplate =
      cleanString(
        req.body.dmTemplate
      );

    const matchMode =
      cleanString(
        req.body.matchMode || "exact"
      ).toLowerCase();

    const publicReplyEnabled =
      req.body.publicReplyEnabled === true;

    const publicReplyTemplate =
      cleanString(
        req.body.publicReplyTemplate
      ) || null;

    if (
      !workspace ||
      !instagramAccountId ||
      !instagramMediaId ||
      !keyword ||
      !destinationUrl ||
      !dmTemplate
    ) {
      return res.status(400).json({
        error: "missing_required_fields"
      });
    }

    if (!validUrl(destinationUrl)) {
      return res.status(400).json({
        error: "invalid_destination_url"
      });
    }

    if (
      !["exact", "contains"].includes(
        matchMode
      )
    ) {
      return res.status(400).json({
        error: "invalid_match_mode"
      });
    }

    if (
      publicReplyEnabled &&
      !publicReplyTemplate
    ) {
      return res.status(400).json({
        error:
          "public_reply_template_required"
      });
    }

    const ownsAccount =
      await accountBelongsToWorkspace(
        instagramAccountId,
        workspace
      );

    if (!ownsAccount) {
      return res.status(404).json({
        error:
          "instagram_account_not_found"
      });
    }

    const entitlements =
      await getWorkspaceEntitlements(
        workspace
      );

    if (!entitlements) {
      return res.status(403).json({
        error:
          "subscription_not_found"
      });
    }

    if (
      !subscriptionAllowsUsage(
        entitlements.status
      )
    ) {
      return res.status(403).json({
        error:
          "subscription_inactive",

        status:
          entitlements.status
      });
    }

    const activeAutomationCount =
      await getWorkspaceActiveAutomationCount(
        workspace
      );

    if (
      activeAutomationCount >=
      entitlements.maxActiveAutomations
    ) {
      return res.status(403).json({
        error:
          "active_automation_limit_reached",

        plan:
          entitlements.planCode,

        current:
          activeAutomationCount,

        limit:
          entitlements.maxActiveAutomations
      });
    }

    const result = await pool.query(
      `
      INSERT INTO automations (
        instagram_account_id,
        instagram_media_id,
        keyword,
        destination_url,
        dm_template,

        public_reply_enabled,
        public_reply_template,

        match_mode,
        active
      )
      VALUES (
        $1,$2,$3,$4,$5,
        $6,$7,$8,TRUE
      )

      RETURNING *
      `,
      [
        instagramAccountId,
        instagramMediaId,
        keyword,
        destinationUrl,
        dmTemplate,

        publicReplyEnabled,
        publicReplyTemplate,

        matchMode
      ]
    );

    const createdAutomation =
      result.rows[0];

    await safeAuditLog({
      workspaceId:
        workspace,

      userId:
        req.auth.userId,

      eventType:
        "automation.created",

      targetType:
        "automation",

      targetId:
        createdAutomation.id,

      ipAddress:
        req.ip,

      userAgent:
        req.get("user-agent"),

      metadata: {
        instagramAccountId:
          createdAutomation
            .instagram_account_id,

        instagramMediaId:
          createdAutomation
            .instagram_media_id,

        keyword:
          createdAutomation.keyword,

        matchMode:
          createdAutomation.match_mode,

        active:
          createdAutomation.active,

        publicReplyEnabled:
          createdAutomation
            .public_reply_enabled
      }
    });

    return res
      .status(201)
      .json({
        automation:
          createdAutomation
      });

  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({
        error:
          "active_trigger_already_exists"
      });
    }

    if (error.code === "RL301") {
      return res.status(403).json({
        error:
          "active_automation_limit_reached"
      });
    }

    if (error.code === "RL202") {
      return res.status(409).json({
        error:
          "instagram_account_not_connected"
      });
    }

    if (error.code === "RL002") {
      return res.status(403).json({
        error:
          "subscription_inactive"
      });
    }

    if (error.code === "RL001") {
      return res.status(403).json({
        error:
          "subscription_not_found"
      });
    }

    console.error(
      "Create automation failed:",
      error.message
    );

    return res.sendStatus(500);
  }
});


// --------------------------------------------------
// PATCH /api/automations/:id
// --------------------------------------------------

router.patch("/:id", async (req, res) => {
  try {
    const workspace =
      workspaceId(req);

    const automationId =
      String(req.params.id);

    const existing =
      await pool.query(
        `
        SELECT
          a.*,
          latest.status
            AS instagram_connection_status

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
          a.id = $1
          AND latest.workspace_id = $2

        LIMIT 1
        `,
        [
          automationId,
          workspace
        ]
      );

    if (existing.rowCount === 0) {
      return res.status(404).json({
        error: "automation_not_found"
      });
    }

    const current =
      existing.rows[0];

    const instagramMediaId =
      req.body.instagramMediaId !== undefined
        ? cleanString(
            req.body.instagramMediaId
          )
        : current.instagram_media_id;

    const keyword =
      req.body.keyword !== undefined
        ? cleanString(
            req.body.keyword
          )
        : current.keyword;

    const destinationUrl =
      req.body.destinationUrl !== undefined
        ? cleanString(
            req.body.destinationUrl
          )
        : current.destination_url;

    const dmTemplate =
      req.body.dmTemplate !== undefined
        ? cleanString(
            req.body.dmTemplate
          )
        : current.dm_template;

    const matchMode =
      req.body.matchMode !== undefined
        ? cleanString(
            req.body.matchMode
          ).toLowerCase()
        : current.match_mode;

    const publicReplyEnabled =
      req.body.publicReplyEnabled !== undefined
        ? req.body.publicReplyEnabled === true
        : current.public_reply_enabled;

    const publicReplyTemplate =
      req.body.publicReplyTemplate !== undefined
        ? (
            cleanString(
              req.body.publicReplyTemplate
            ) || null
          )
        : current.public_reply_template;

    const active =
      req.body.active !== undefined
        ? req.body.active === true
        : current.active;

    if (
      !instagramMediaId ||
      !keyword ||
      !destinationUrl ||
      !dmTemplate
    ) {
      return res.status(400).json({
        error: "invalid_empty_field"
      });
    }

    if (!validUrl(destinationUrl)) {
      return res.status(400).json({
        error: "invalid_destination_url"
      });
    }

    if (
      !["exact", "contains"].includes(
        matchMode
      )
    ) {
      return res.status(400).json({
        error: "invalid_match_mode"
      });
    }

    if (
      publicReplyEnabled &&
      !publicReplyTemplate
    ) {
      return res.status(400).json({
        error:
          "public_reply_template_required"
      });
    }

    if (
      current.active === false &&
      active === true
    ) {
      if (
        current.instagram_connection_status !==
        "connected"
      ) {
        return res.status(409).json({
          error:
            "instagram_account_not_connected",

          status:
            current.instagram_connection_status
        });
      }

      const entitlements =
        await getWorkspaceEntitlements(
          workspace
        );

      if (!entitlements) {
        return res.status(403).json({
          error:
            "subscription_not_found"
        });
      }

      if (
        !subscriptionAllowsUsage(
          entitlements.status
        )
      ) {
        return res.status(403).json({
          error:
            "subscription_inactive",

          status:
            entitlements.status
        });
      }

      const activeAutomationCount =
        await getWorkspaceActiveAutomationCount(
          workspace
        );

      if (
        activeAutomationCount >=
        entitlements.maxActiveAutomations
      ) {
        return res.status(403).json({
          error:
            "active_automation_limit_reached",

          plan:
            entitlements.planCode,

          current:
            activeAutomationCount,

          limit:
            entitlements.maxActiveAutomations
        });
      }
    }

    const result = await pool.query(
      `
      UPDATE automations
      SET
        instagram_media_id = $1,
        keyword = $2,
        destination_url = $3,
        dm_template = $4,

        public_reply_enabled = $5,
        public_reply_template = $6,

        match_mode = $7,
        active = $8,

        updated_at = NOW()

      WHERE id = $9

      RETURNING *
      `,
      [
        instagramMediaId,
        keyword,
        destinationUrl,
        dmTemplate,

        publicReplyEnabled,
        publicReplyTemplate,

        matchMode,
        active,

        automationId
      ]
    );

    const updatedAutomation =
      result.rows[0];

    const changedFields = [];

    if (
      current.instagram_media_id !==
      updatedAutomation.instagram_media_id
    ) {
      changedFields.push(
        "instagramMediaId"
      );
    }

    if (
      current.keyword !==
      updatedAutomation.keyword
    ) {
      changedFields.push(
        "keyword"
      );
    }

    if (
      current.match_mode !==
      updatedAutomation.match_mode
    ) {
      changedFields.push(
        "matchMode"
      );
    }

    if (
      current.active !==
      updatedAutomation.active
    ) {
      changedFields.push(
        "active"
      );
    }

    if (
      current.public_reply_enabled !==
      updatedAutomation.public_reply_enabled
    ) {
      changedFields.push(
        "publicReplyEnabled"
      );
    }

    if (
      current.destination_url !==
      updatedAutomation.destination_url
    ) {
      changedFields.push(
        "destinationUrl"
      );
    }

    if (
      current.dm_template !==
      updatedAutomation.dm_template
    ) {
      changedFields.push(
        "dmTemplate"
      );
    }

    if (
      current.public_reply_template !==
      updatedAutomation.public_reply_template
    ) {
      changedFields.push(
        "publicReplyTemplate"
      );
    }

    await safeAuditLog({
      workspaceId:
        workspace,

      userId:
        req.auth.userId,

      eventType:
        "automation.updated",

      targetType:
        "automation",

      targetId:
        updatedAutomation.id,

      ipAddress:
        req.ip,

      userAgent:
        req.get("user-agent"),

      metadata: {
        instagramAccountId:
          updatedAutomation
            .instagram_account_id,

        keyword:
          updatedAutomation.keyword,

        active:
          updatedAutomation.active,

        changedFields
      }
    });

    return res.json({
      automation:
        updatedAutomation
    });

  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({
        error:
          "active_trigger_already_exists"
      });
    }

    if (error.code === "RL301") {
      return res.status(403).json({
        error:
          "active_automation_limit_reached"
      });
    }

    if (error.code === "RL202") {
      return res.status(409).json({
        error:
          "instagram_account_not_connected"
      });
    }

    if (error.code === "RL002") {
      return res.status(403).json({
        error:
          "subscription_inactive"
      });
    }

    if (error.code === "RL001") {
      return res.status(403).json({
        error:
          "subscription_not_found"
      });
    }

    console.error(
      "Update automation failed:",
      error.message
    );

    return res.sendStatus(500);
  }
});


// --------------------------------------------------
// DELETE /api/automations/:id
// --------------------------------------------------

router.delete("/:id", async (req, res) => {
  try {
    const workspace =
      workspaceId(req);

    const result = await pool.query(
      `
      DELETE FROM automations a

      USING instagram_accounts ia

      WHERE
        a.id = $1

        AND ia.id =
          a.instagram_account_id

        AND EXISTS (
          SELECT 1

          FROM instagram_connections ic

          WHERE
            ic.instagram_account_id =
              ia.id

            AND ic.workspace_id = $2

            AND ic.id = (
              SELECT ic2.id

              FROM instagram_connections ic2

              WHERE
                ic2.instagram_account_id =
                  ia.id

              ORDER BY
                ic2.connected_at DESC,
                ic2.created_at DESC

              LIMIT 1
            )
        )

      RETURNING
        a.id,
        a.instagram_account_id,
        a.instagram_media_id,
        a.keyword,
        a.match_mode,
        a.active,
        a.public_reply_enabled
      `,
      [
        req.params.id,
        workspace
      ]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({
        error: "automation_not_found"
      });
    }

    const deletedAutomation =
      result.rows[0];

    await safeAuditLog({
      workspaceId:
        workspace,

      userId:
        req.auth.userId,

      eventType:
        "automation.deleted",

      targetType:
        "automation",

      targetId:
        deletedAutomation.id,

      ipAddress:
        req.ip,

      userAgent:
        req.get("user-agent"),

      metadata: {
        instagramAccountId:
          deletedAutomation
            .instagram_account_id,

        instagramMediaId:
          deletedAutomation
            .instagram_media_id,

        keyword:
          deletedAutomation.keyword,

        matchMode:
          deletedAutomation.match_mode,

        active:
          deletedAutomation.active,

        publicReplyEnabled:
          deletedAutomation
            .public_reply_enabled
      }
    });

    return res.json({
      deleted: true,
      id:
        deletedAutomation.id
    });

  } catch (error) {
    console.error(
      "Delete automation failed:",
      error.message
    );

    return res.sendStatus(500);
  }
});


module.exports = router;
