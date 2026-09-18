const express = require("express");

const pool = require("../db");

const {
  requireAuth
} = require("../lib/auth");

const {
  decryptToken
} = require("../lib/token-crypto");

const router = express.Router();

const API_VERSION =
  process.env.INSTAGRAM_API_VERSION ||
  "v26.0";

router.use(requireAuth);


// --------------------------------------------------
// GET /api/instagram/accounts
// --------------------------------------------------

router.get(
  "/accounts",
  async (req, res) => {
    try {
      const result =
        await pool.query(
          `
          SELECT
            ia.id,
            ia.username,
            ia.account_type,
            ia.professional_account_id,

            latest.status,
            latest.token_expires_at,
            latest.connected_at

          FROM instagram_accounts ia

          JOIN LATERAL (
            SELECT
              ic.status,
              ic.token_expires_at,
              ic.connected_at,
              ic.created_at

            FROM instagram_connections ic

            WHERE
              ic.instagram_account_id =
                ia.id

              AND ic.workspace_id =
                $1

            ORDER BY
              ic.connected_at DESC,
              ic.created_at DESC

            LIMIT 1
          ) latest
            ON TRUE

          ORDER BY
            ia.username ASC
          `,
          [
            req.auth.workspaceId
          ]
        );

      return res.json({
        accounts:
          result.rows.map(
            (row) => ({
              id:
                row.id,

              username:
                row.username,

              accountType:
                row.account_type,

              professionalAccountId:
                row.professional_account_id,

              status:
                row.status,

              tokenExpiresAt:
                row.token_expires_at,

              connectedAt:
                row.connected_at
            })
          )
      });

    } catch (error) {
      console.error(
        "Instagram account list failed:",
        error.message
      );

      return res.sendStatus(500);
    }
  }
);


// --------------------------------------------------
// GET /api/instagram/accounts/:id/media
// --------------------------------------------------

router.get(
  "/accounts/:id/media",
  async (req, res) => {
    try {
      const accountId =
        String(req.params.id);

      const accountResult =
        await pool.query(
          `
          SELECT
            ia.id,
            ia.username,
            ia.professional_account_id,

            latest.status,
            latest.token_ciphertext,
            latest.token_iv,
            latest.token_auth_tag,
            latest.token_key_version

          FROM instagram_accounts ia

          JOIN LATERAL (
            SELECT
              ic.status,
              ic.token_ciphertext,
              ic.token_iv,
              ic.token_auth_tag,
              ic.token_key_version,
              ic.connected_at,
              ic.created_at

            FROM instagram_connections ic

            WHERE
              ic.instagram_account_id =
                ia.id

              AND ic.workspace_id =
                $2

            ORDER BY
              ic.connected_at DESC,
              ic.created_at DESC

            LIMIT 1
          ) latest
            ON TRUE

          WHERE ia.id = $1

          LIMIT 1
          `,
          [
            accountId,
            req.auth.workspaceId
          ]
        );

      if (
        accountResult.rowCount === 0
      ) {
        return res.status(404).json({
          error:
            "instagram_account_not_found"
        });
      }

      const account =
        accountResult.rows[0];

      if (
        account.status !== "connected"
      ) {
        return res.status(409).json({
          error:
            "instagram_reconnect_required"
        });
      }

      if (
        !account.token_ciphertext ||
        !account.token_iv ||
        !account.token_auth_tag
      ) {
        return res.status(409).json({
          error:
            "instagram_token_unavailable"
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

      const url =
        new URL(
          `https://graph.instagram.com/${API_VERSION}/me/media`
        );

      url.searchParams.set(
        "fields",
        [
          "id",
          "caption",
          "media_type",
          "media_product_type",
          "permalink",
          "timestamp",
          "thumbnail_url"
        ].join(",")
      );

      url.searchParams.set(
        "limit",
        "25"
      );

      const after =
        String(
          req.query.after || ""
        ).trim();

      if (after) {
        if (after.length > 2048) {
          return res.status(400).json({
            error:
              "invalid_pagination_cursor"
          });
        }

        url.searchParams.set(
          "after",
          after
        );
      }

      const controller =
        new AbortController();

      const timeout =
        setTimeout(
          () => controller.abort(),
          20000
        );

      let response;

      try {
        response =
          await fetch(
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
          "Instagram media API failed:",
          {
            account:
              account.username,

            status:
              response.status
          }
        );

        return res.status(502).json({
          error:
            "instagram_media_fetch_failed"
        });
      }

      return res.json({
        account: {
          id:
            account.id,

          username:
            account.username
        },

        media:
          Array.isArray(body.data)
            ? body.data
            : [],

        // Do not return Meta's paging.next URL,
        // because it may contain credentials.
        nextCursor:
          body.paging
            ?.cursors
            ?.after || null
      });

    } catch (error) {
      console.error(
        "Instagram media list failed:",
        error.message
      );

      return res.sendStatus(500);
    }
  }
);

module.exports = router;
