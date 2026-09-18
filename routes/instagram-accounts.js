const express = require("express");

const pool = require("../db");

const {
  requireAuth
} = require("../lib/auth");

const {
  decryptToken
} = require("../lib/token-crypto");

const {
  createOAuthState
} = require("../lib/oauth-state");

const {
  buildAuthorizationUrl
} = require("../lib/instagram-oauth");

const {
  safeAuditLog
} = require("../lib/audit-log");

const {
  subscriptionAllowsUsage,
  getWorkspaceEntitlements,
  getWorkspaceInstagramAccountCount
} = require("../lib/entitlements");


const {
  requireSameOrigin
} = require("../lib/same-origin");

const router = express.Router();

const API_VERSION =
  process.env.INSTAGRAM_API_VERSION ||
  "v26.0";

router.use(requireAuth);
router.use(requireSameOrigin);


// --------------------------------------------------
// GET /api/instagram/accounts
// --------------------------------------------------

router.get("/", async (req, res) => {
  try {
    const result = await pool.query(
      `
      SELECT
        ia.id,
        ia.professional_account_id,
        ia.username,
        ia.account_type,

        ic.status,
        ic.token_expires_at,
        ic.token_last_refreshed_at,
        ic.comments_subscribed_at,
        ic.reauth_required_at,
        ic.connected_at

      FROM instagram_accounts ia

      JOIN LATERAL (
        SELECT
          ic.status,
          ic.token_expires_at,
          ic.token_last_refreshed_at,
          ic.comments_subscribed_at,
          ic.reauth_required_at,
          ic.connected_at,
          ic.created_at

        FROM instagram_connections ic

        WHERE
          ic.instagram_account_id = ia.id
          AND ic.workspace_id = $1

        ORDER BY
          ic.connected_at DESC,
          ic.created_at DESC

        LIMIT 1
      ) ic
        ON TRUE

      ORDER BY
        ic.connected_at DESC
      `,
      [req.auth.workspaceId]
    );

    return res.json({
      accounts: result.rows
    });

  } catch (error) {
    console.error(
      "List Instagram accounts failed:",
      error.message
    );

    return res.sendStatus(500);
  }
});


// --------------------------------------------------
// Internal workspace/account lookup
// --------------------------------------------------

async function getWorkspaceAccount(
  accountId,
  workspaceId
) {
  const result = await pool.query(
    `
    SELECT
      ia.id,
      ia.professional_account_id,
      ia.username,
      ia.account_type,

      ic.status,
      ic.token_ciphertext,
      ic.token_iv,
      ic.token_auth_tag,
      ic.token_key_version,
      ic.token_expires_at

    FROM instagram_accounts ia

    JOIN LATERAL (
      SELECT
        ic.status,
        ic.token_ciphertext,
        ic.token_iv,
        ic.token_auth_tag,
        ic.token_key_version,
        ic.token_expires_at,
        ic.connected_at,
        ic.created_at

      FROM instagram_connections ic

      WHERE
        ic.instagram_account_id = ia.id
        AND ic.workspace_id = $2

      ORDER BY
        ic.connected_at DESC,
        ic.created_at DESC

      LIMIT 1
    ) ic
      ON TRUE

    WHERE ia.id = $1

    LIMIT 1
    `,
    [
      accountId,
      workspaceId
    ]
  );

  return result.rows[0] || null;
}


// --------------------------------------------------
// GET /api/instagram/accounts/:id/media
// --------------------------------------------------

router.get(
  "/:id/media",

  async (req, res) => {
    try {
      const account =
        await getWorkspaceAccount(
          req.params.id,
          req.auth.workspaceId
        );

      if (!account) {
        return res
          .status(404)
          .json({
            error:
              "instagram_account_not_found"
          });
      }

      if (
        account.status !== "connected"
      ) {
        return res
          .status(409)
          .json({
            error:
              "instagram_account_not_connected",

            status:
              account.status
          });
      }

      const token =
        decryptToken({
          ciphertext:
            account.token_ciphertext,

          iv:
            account.token_iv,

          authTag:
            account.token_auth_tag,

          keyVersion:
            account.token_key_version
        });

      const url = new URL(
        `https://graph.instagram.com/${API_VERSION}/me/media`
      );

      url.searchParams.set(
        "fields",
        [
          "id",
          "caption",
          "media_type",
          "media_url",
          "thumbnail_url",
          "permalink",
          "timestamp"
        ].join(",")
      );

      url.searchParams.set(
        "limit",
        "50"
      );

      const controller =
        new AbortController();

      const timeout =
        setTimeout(
          () => controller.abort(),
          20000
        );

      let response;

      try {
        response = await fetch(
          url,
          {
            headers: {
              Authorization:
                `Bearer ${token}`
            },

            signal:
              controller.signal
          }
        );

      } finally {
        clearTimeout(timeout);
      }

      const responseText =
        await response.text();

      let body;

      try {
        body =
          JSON.parse(responseText);

      } catch {
        body = {
          raw:
            responseText.slice(
              0,
              1000
            )
        };
      }

      if (!response.ok) {
        console.error(
          "Instagram media fetch failed:",
          {
            account:
              account.username,

            httpStatus:
              response.status,

            error:
              body?.error?.message ||
              "unknown"
          }
        );

        return res
          .status(502)
          .json({
            error:
              "instagram_media_fetch_failed"
          });
      }

      const media =
        Array.isArray(body.data)
          ? body.data.map(
              item => ({
                id:
                  item.id,

                caption:
                  item.caption ||
                  null,

                mediaType:
                  item.media_type ||
                  null,

                mediaUrl:
                  item.media_url ||
                  null,

                thumbnailUrl:
                  item.thumbnail_url ||
                  null,

                permalink:
                  item.permalink ||
                  null,

                timestamp:
                  item.timestamp ||
                  null
              })
            )
          : [];

      return res.json({
        account: {
          id:
            account.id,

          username:
            account.username,

          accountType:
            account.account_type
        },

        media
      });

    } catch (error) {
      console.error(
        "Instagram media lookup failed:",
        error.message
      );

      return res.sendStatus(500);
    }
  }
);



// --------------------------------------------------
// POST /api/instagram/accounts/connect
// --------------------------------------------------

router.post(
  "/connect",
  async (req, res) => {
    try {
      const entitlements =
        await getWorkspaceEntitlements(
          req.auth.workspaceId
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

      const accountCount =
        await getWorkspaceInstagramAccountCount(
          req.auth.workspaceId
        );

      if (
        accountCount >=
        entitlements.maxInstagramAccounts
      ) {
        return res.status(403).json({
          error:
            "instagram_account_limit_reached",

          plan:
            entitlements.planCode,

          current:
            accountCount,

          limit:
            entitlements.maxInstagramAccounts
        });
      }

      const oauthState =
        await createOAuthState(
          req.auth.workspaceId
        );

      const authorizationUrl =
        buildAuthorizationUrl(
          oauthState.state
        );

      await safeAuditLog({
        workspaceId:
          req.auth.workspaceId,

        userId:
          req.auth.userId,

        eventType:
          "instagram.connect_started",

        targetType:
          "workspace",

        targetId:
          req.auth.workspaceId,

        ipAddress:
          req.ip,

        userAgent:
          req.get("user-agent"),

        metadata: {
          oauthExpiresAt:
            oauthState.expiresAt
        }
      });

      return res.json({
        authorizationUrl,
        expiresAt:
          oauthState.expiresAt
      });

    } catch (error) {
      console.error(
        "Instagram connect start failed:",
        error.message
      );

      return res
        .status(500)
        .json({
          error:
            "instagram_connect_start_failed"
        });
    }
  }
);


module.exports = router;
