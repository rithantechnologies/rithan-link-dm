const express = require("express");
const crypto = require("crypto");

const pool = require("../db");

const router = express.Router();

const APP_SECRET =
  process.env.META_APP_SECRET;

const PUBLIC_BASE_URL =
  process.env.PUBLIC_API_URL ||
  "https://api.rithantechnologies.com";

router.use(
  express.urlencoded({
    extended: false
  })
);

function decodeBase64Url(value) {
  let normalized =
    String(value)
      .replace(/-/g, "+")
      .replace(/_/g, "/");

  while (normalized.length % 4 !== 0) {
    normalized += "=";
  }

  return Buffer.from(
    normalized,
    "base64"
  );
}

function parseSignedRequest(signedRequest) {
  if (!APP_SECRET) {
    throw new Error(
      "META_APP_SECRET is not configured"
    );
  }

  if (!signedRequest) {
    throw new Error(
      "Missing signed_request"
    );
  }

  const parts =
    String(signedRequest).split(".");

  if (parts.length !== 2) {
    throw new Error(
      "Malformed signed_request"
    );
  }

  const [
    encodedSignature,
    encodedPayload
  ] = parts;

  const signature =
    decodeBase64Url(
      encodedSignature
    );

  const expected =
    crypto
      .createHmac(
        "sha256",
        APP_SECRET
      )
      .update(encodedPayload)
      .digest();

  if (
    signature.length !==
    expected.length ||
    !crypto.timingSafeEqual(
      signature,
      expected
    )
  ) {
    throw new Error(
      "Invalid signed_request signature"
    );
  }

  let payload;

  try {
    payload =
      JSON.parse(
        decodeBase64Url(
          encodedPayload
        ).toString("utf8")
      );
  } catch {
    throw new Error(
      "Invalid signed_request payload"
    );
  }

  if (
    String(
      payload.algorithm || ""
    ).toUpperCase() !==
    "HMAC-SHA256"
  ) {
    throw new Error(
      "Unsupported signed_request algorithm"
    );
  }

  if (!payload.user_id) {
    throw new Error(
      "signed_request missing user_id"
    );
  }

  return payload;
}


// --------------------------------------------------
// Deauthorization
// --------------------------------------------------

router.post(
  "/deauthorize",
  async (req, res) => {
    try {
      const payload =
        parseSignedRequest(
          req.body?.signed_request
        );

      const appScopedUserId =
        String(payload.user_id);

      const result =
        await pool.query(
          `
          UPDATE instagram_connections ic
          SET
            token_ciphertext = NULL,
            token_iv = NULL,
            token_auth_tag = NULL,
            token_key_version = NULL,
            token_expires_at = NULL,

            status = 'disconnected',

            comments_subscribed_at = NULL,
            reauth_required_at = NULL,

            disconnected_at = NOW(),
            updated_at = NOW(),

            last_error =
              'Meta deauthorization callback received'

          FROM instagram_accounts ia

          WHERE
            ic.instagram_account_id =
              ia.id

            AND ia.app_scoped_user_id =
              $1

          RETURNING ic.id
          `,
          [appScopedUserId]
        );

      console.log(
        "Meta deauthorization processed:",
        {
          connections:
            result.rowCount
        }
      );

      return res.sendStatus(200);

    } catch (error) {
      console.error(
        "Meta deauthorization rejected:",
        error.message
      );

      return res
        .status(400)
        .json({
          error:
            "invalid_signed_request"
        });
    }
  }
);


// --------------------------------------------------
// Data deletion
// --------------------------------------------------

router.post(
  "/data-deletion",
  async (req, res) => {
    let confirmationCode = null;

    try {
      const payload =
        parseSignedRequest(
          req.body?.signed_request
        );

      const appScopedUserId =
        String(payload.user_id);

      confirmationCode =
        crypto
          .randomBytes(24)
          .toString("hex");

      await pool.query(
        `
        INSERT INTO
          meta_data_deletion_requests (
            confirmation_code,
            status
          )
        VALUES ($1, 'pending')
        `,
        [confirmationCode]
      );

      const client =
        await pool.connect();

      let deletedCount = 0;

      try {
        await client.query("BEGIN");

        const accounts =
          await client.query(
            `
            SELECT id
            FROM instagram_accounts
            WHERE app_scoped_user_id = $1
            FOR UPDATE
            `,
            [appScopedUserId]
          );

        deletedCount =
          accounts.rowCount;

        const accountIds =
          accounts.rows.map(
            (row) => row.id
          );

        if (accountIds.length > 0) {
          // These rows otherwise survive because
          // their FK uses ON DELETE SET NULL.
          await client.query(
            `
            DELETE FROM webhook_events
            WHERE instagram_account_id =
              ANY($1::uuid[])
            `,
            [accountIds]
          );

          // Must go before instagram_accounts because
          // this FK uses ON DELETE RESTRICT.
          await client.query(
            `
            DELETE FROM instagram_connections
            WHERE instagram_account_id =
              ANY($1::uuid[])
            `,
            [accountIds]
          );

          // Cascades remove:
          // automations
          // processed_comments
          // dm_logs
          // public_reply_logs
          await client.query(
            `
            DELETE FROM instagram_accounts
            WHERE id =
              ANY($1::uuid[])
            `,
            [accountIds]
          );
        }

        await client.query(
          `
          UPDATE meta_data_deletion_requests
          SET
            status = 'completed',
            deleted_accounts_count = $1,
            completed_at = NOW(),
            error_message = NULL
          WHERE confirmation_code = $2
          `,
          [
            deletedCount,
            confirmationCode
          ]
        );

        await client.query("COMMIT");

      } catch (error) {
        await client.query("ROLLBACK");
        throw error;

      } finally {
        client.release();
      }

      const statusUrl =
        `${PUBLIC_BASE_URL}/meta/data-deletion/status/${confirmationCode}`;

      console.log(
        "Meta data deletion completed:",
        {
          confirmationCode,
          deletedAccounts:
            deletedCount
        }
      );

      return res.json({
        url: statusUrl,
        confirmation_code:
          confirmationCode
      });

    } catch (error) {
      console.error(
        "Meta data deletion failed:",
        error.message
      );

      if (confirmationCode) {
        try {
          await pool.query(
            `
            UPDATE meta_data_deletion_requests
            SET
              status = 'failed',
              error_message = $1
            WHERE confirmation_code = $2
            `,
            [
              String(
                error.message
              ).slice(0, 2000),

              confirmationCode
            ]
          );
        } catch {}
      }

      return res
        .status(400)
        .json({
          error:
            "invalid_or_failed_request"
        });
    }
  }
);


// --------------------------------------------------
// Public deletion status
// --------------------------------------------------

router.get(
  "/data-deletion/status/:code",
  async (req, res) => {
    try {
      const code =
        String(
          req.params.code || ""
        );

      const result =
        await pool.query(
          `
          SELECT
            confirmation_code,
            status,
            deleted_accounts_count,
            requested_at,
            completed_at

          FROM meta_data_deletion_requests

          WHERE confirmation_code = $1

          LIMIT 1
          `,
          [code]
        );

      const row =
        result.rows[0];

      if (!row) {
        return res
          .status(404)
          .type("html")
          .send(`
<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Data deletion status</title>
</head>
<body>
  <h1>Data deletion request not found</h1>
</body>
</html>
          `);
      }

      const message =
        row.status === "completed"
          ? "Instagram-connected data associated with this request has been deleted."
          : row.status === "failed"
            ? "The deletion request could not be completed automatically."
            : "The deletion request is being processed.";

      return res
        .status(200)
        .type("html")
        .send(`
<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Rithan Technologies - Data Deletion</title>
</head>
<body>
  <h1>Data deletion status</h1>

  <p>
    Status:
    <strong>${row.status}</strong>
  </p>

  <p>
    Confirmation code:
    <code>${row.confirmation_code}</code>
  </p>

  <p>${message}</p>
</body>
</html>
        `);

    } catch (error) {
      console.error(
        "Deletion status lookup failed:",
        error.message
      );

      return res.sendStatus(500);
    }
  }
);

module.exports = router;
