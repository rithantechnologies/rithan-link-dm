const express = require("express");
const crypto = require("crypto");

const pool = require("../db");

const {
  requireAuth
} = require("../lib/auth");

const router = express.Router();

// --------------------------------------------------
// Customer session authentication
// --------------------------------------------------

router.use(requireAuth);

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
        ic.workspace_id

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

    return res
      .status(201)
      .json({
        automation:
          result.rows[0]
      });

  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({
        error:
          "active_trigger_already_exists"
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
        SELECT a.*

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

    return res.json({
      automation:
        result.rows[0]
    });

  } catch (error) {
    if (error.code === "23505") {
      return res.status(409).json({
        error:
          "active_trigger_already_exists"
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

      RETURNING a.id
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

    return res.json({
      deleted: true,
      id: result.rows[0].id
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
