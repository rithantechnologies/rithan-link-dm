const express = require("express");

const pool = require("../db");

const {
  consumeOAuthState
} = require("../lib/oauth-state");

const {
  encryptToken
} = require("../lib/token-crypto");

const {
  exchangeCodeForToken,
  exchangeForLongLivedToken,
  getInstagramProfile,
  subscribeToComments
} = require("../lib/instagram-api");

const {
  safeAuditLog
} = require("../lib/audit-log");

const {
  subscriptionAllowsUsage,
  getWorkspaceEntitlements,
  getWorkspaceInstagramAccountCount
} = require("../lib/entitlements");

const router = express.Router();

router.get("/callback", async (req, res) => {
  const {
    code,
    state,
    error,
    error_reason,
    error_description
  } = req.query;

  if (!state) {
    return res.status(400).send(
      "Instagram connection failed: missing OAuth state."
    );
  }

  let oauthState;

  try {
    oauthState = await consumeOAuthState(state);
  } catch (err) {
    console.error("OAuth state validation error:", err.message);

    return res.status(500).send(
      "Instagram connection failed."
    );
  }

  if (!oauthState) {
    return res.status(400).send(
      "This Instagram authorization link has expired or was already used."
    );
  }

  if (error) {
    console.log("Instagram authorization cancelled:", {
      error,
      error_reason,
      error_description
    });

    return res.status(400).send(
      "Instagram connection was cancelled."
    );
  }

  if (!code) {
    return res.status(400).send(
      "Instagram did not provide an authorization code."
    );
  }

  let client;

  try {
    // 1. Authorization code -> short-lived token
    const shortResult =
      await exchangeCodeForToken(code);

    if (!shortResult.access_token) {
      throw new Error(
        "No short-lived access token returned"
      );
    }

    const exchangeUserId =
      shortResult.user_id
        ? String(shortResult.user_id)
        : null;

    // 2. Short-lived -> long-lived token
    const longResult =
      await exchangeForLongLivedToken(
        shortResult.access_token
      );

    if (!longResult.access_token) {
      throw new Error(
        "No long-lived access token returned"
      );
    }

    const longToken =
      longResult.access_token;

    const expiresIn =
      Number(longResult.expires_in || 0);

    if (!expiresIn) {
      throw new Error(
        "No token expiry returned"
      );
    }

    // 3. Resolve account IDs
    const profile =
      await getInstagramProfile(longToken);

    const professionalAccountId =
      profile.user_id
        ? String(profile.user_id)
        : null;

    if (!professionalAccountId) {
      throw new Error(
        "Instagram profile did not return user_id"
      );
    }

    const appScopedUserId =
      profile.id
        ? String(profile.id)
        : exchangeUserId;

    console.log(
      "Instagram OAuth identity resolved:",
      {
        appScopedUserId,
        professionalAccountId,
        username: profile.username
      }
    );

    const entitlements =
      await getWorkspaceEntitlements(
        oauthState.workspace_id
      );

    if (!entitlements) {
      const planError =
        new Error(
          "Workspace subscription not found"
        );

      planError.code = "RL001";
      throw planError;
    }

    if (
      !subscriptionAllowsUsage(
        entitlements.status
      )
    ) {
      const planError =
        new Error(
          "Workspace subscription is inactive"
        );

      planError.code = "RL002";
      throw planError;
    }

    const existingLive =
      await pool.query(
        `
        SELECT 1
        FROM instagram_accounts ia
        JOIN instagram_connections ic
          ON ic.instagram_account_id =
             ia.id
        WHERE
          ia.professional_account_id = $1
          AND ic.workspace_id = $2
          AND ic.status IN (
            'connected',
            'reauth_required'
          )
        LIMIT 1
        `,
        [
          professionalAccountId,
          oauthState.workspace_id
        ]
      );

    if (
      existingLive.rowCount === 0
    ) {
      const accountCount =
        await getWorkspaceInstagramAccountCount(
          oauthState.workspace_id
        );

      if (
        accountCount >=
        entitlements.maxInstagramAccounts
      ) {
        const planError =
          new Error(
            "Instagram account plan limit reached"
          );

        planError.code = "RL101";
        throw planError;
      }
    }

    // 4. Subscribe account to real comment webhooks
    const subscription =
      await subscribeToComments(
        professionalAccountId,
        longToken
      );

    if (subscription.success !== true) {
      throw new Error(
        "Instagram comment subscription failed"
      );
    }

    // 5. Encrypt token
    const encrypted =
      encryptToken(longToken);

    const tokenExpiresAt =
      new Date(
        Date.now() +
        expiresIn * 1000
      );

    client = await pool.connect();

    await client.query("BEGIN");

    // 6. Upsert the Instagram Professional account
    const accountResult =
      await client.query(
        `
        INSERT INTO instagram_accounts (
          professional_account_id,
          app_scoped_user_id,
          username,
          account_type
        )
        VALUES ($1, $2, $3, $4)

        ON CONFLICT (professional_account_id)
        DO UPDATE SET
          app_scoped_user_id = EXCLUDED.app_scoped_user_id,
          username = EXCLUDED.username,
          account_type = EXCLUDED.account_type,
          updated_at = NOW()

        RETURNING id
        `,
        [
          professionalAccountId,
          appScopedUserId,
          profile.username || null,
          profile.account_type || null
        ]
      );

    const instagramAccountId =
      accountResult.rows[0].id;

    // 7. Check whether already connected
    const connectionResult =
      await client.query(
        `
        SELECT
          id,
          workspace_id
        FROM instagram_connections
        WHERE instagram_account_id = $1
          AND status IN (
            'connected',
            'reauth_required'
          )
        FOR UPDATE
        `,
        [instagramAccountId]
      );

    if (
      connectionResult.rows.length > 0 &&
      String(
        connectionResult.rows[0].workspace_id
      ) !== String(oauthState.workspace_id)
    ) {
      throw new Error(
        "This Instagram account is already connected to another workspace."
      );
    }

    if (connectionResult.rows.length > 0) {
      // Reconnect / reauthorization for same workspace
      await client.query(
        `
        UPDATE instagram_connections
        SET
          token_ciphertext = $1,
          token_iv = $2,
          token_auth_tag = $3,
          token_key_version = $4,
          token_expires_at = $5,
          token_last_refreshed_at = NOW(),
          status = 'connected',
          comments_subscribed_at = NOW(),
          reauth_required_at = NULL,
          disconnected_at = NULL,
          last_error = NULL,
          updated_at = NOW()
        WHERE id = $6
        `,
        [
          encrypted.ciphertext,
          encrypted.iv,
          encrypted.authTag,
          encrypted.keyVersion,
          tokenExpiresAt,
          connectionResult.rows[0].id
        ]
      );
    } else {
      // New connection
      await client.query(
        `
        INSERT INTO instagram_connections (
          workspace_id,
          instagram_account_id,
          token_ciphertext,
          token_iv,
          token_auth_tag,
          token_key_version,
          token_expires_at,
          token_last_refreshed_at,
          status,
          comments_subscribed_at
        )
        VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7,
          NOW(),
          'connected',
          NOW()
        )
        `,
        [
          oauthState.workspace_id,
          instagramAccountId,
          encrypted.ciphertext,
          encrypted.iv,
          encrypted.authTag,
          encrypted.keyVersion,
          tokenExpiresAt
        ]
      );
    }

    await client.query(
      `INSERT INTO instagram_delivery_safety (
         instagram_account_id
       )
       VALUES ($1)
       ON CONFLICT (instagram_account_id)
       DO NOTHING`,
      [instagramAccountId]
    );

    await client.query("COMMIT");

    console.log(
      "Instagram SaaS connection complete:",
      {
        workspaceId:
          oauthState.workspace_id,
        professionalAccountId,
        username: profile.username
      }
    );

    await safeAuditLog({
      workspaceId:
        oauthState.workspace_id,

      userId:
        null,

      eventType:
        "instagram.connected",

      targetType:
        "instagram_account",

      targetId:
        instagramAccountId,

      ipAddress:
        req.ip,

      userAgent:
        req.get("user-agent"),

      metadata: {
        username:
          profile.username || null,

        professionalAccountId:
          professionalAccountId,

        accountType:
          profile.account_type || null
      }
    });

    const params =
      new URLSearchParams({
        instagram: "connected",
        username:
          profile.username || ""
      });

    return res.redirect(
      303,
      `/dashboard/?${params.toString()}`
    );

  } catch (err) {
    if (client) {
      try {
        await client.query("ROLLBACK");
      } catch {}
    }

    console.error(
      "Instagram OAuth callback failed:",
      err.message
    );

    if (err.code === "RL101") {
      return res.status(409).send(
        "Instagram account limit reached for this plan."
      );
    }

    if (err.code === "RL002") {
      return res.status(403).send(
        "This workspace subscription is inactive."
      );
    }

    if (err.code === "RL001") {
      return res.status(403).send(
        "Workspace subscription not found."
      );
    }

    return res.status(500).send(
      "Instagram connection failed. Please start again."
    );

  } finally {
    if (client) {
      client.release();
    }
  }
});

module.exports = router;
