require("dotenv").config();

const pool = require("../db");

const {
  encryptToken,
  decryptToken
} = require("../lib/token-crypto");

const REFRESH_WINDOW_DAYS =
  Number(
    process.env.INSTAGRAM_TOKEN_REFRESH_WINDOW_DAYS ||
    10
  );

const MIN_TOKEN_AGE_MS =
  24 * 60 * 60 * 1000;

const DRY_RUN =
  process.argv.includes("--dry-run");

const forceIndex =
  process.argv.indexOf("--force");

const FORCE_USERNAME =
  forceIndex >= 0
    ? process.argv[forceIndex + 1]
    : null;


// ----------------------------------------------------
// Candidate lookup
// ----------------------------------------------------

async function getCandidates() {
  if (FORCE_USERNAME) {
    const result = await pool.query(
      `
      SELECT
        ic.id AS connection_id,
        ia.username,
        ia.professional_account_id,

        ic.token_ciphertext,
        ic.token_iv,
        ic.token_auth_tag,
        ic.token_key_version,

        ic.token_expires_at,
        ic.token_last_refreshed_at,
        ic.connected_at

      FROM instagram_connections ic

      JOIN instagram_accounts ia
        ON ia.id = ic.instagram_account_id

      WHERE ic.status = 'connected'
        AND LOWER(ia.username) = LOWER($1)

      LIMIT 1
      `,
      [FORCE_USERNAME]
    );

    return result.rows;
  }

  const result = await pool.query(
    `
    SELECT
      ic.id AS connection_id,
      ia.username,
      ia.professional_account_id,

      ic.token_ciphertext,
      ic.token_iv,
      ic.token_auth_tag,
      ic.token_key_version,

      ic.token_expires_at,
      ic.token_last_refreshed_at,
      ic.connected_at

    FROM instagram_connections ic

    JOIN instagram_accounts ia
      ON ia.id = ic.instagram_account_id

    WHERE ic.status = 'connected'

      AND ic.token_expires_at IS NOT NULL

      AND ic.token_expires_at <=
        NOW() +
        ($1::double precision * INTERVAL '1 day')

      AND COALESCE(
        ic.token_last_refreshed_at,
        ic.connected_at
      ) <= NOW() - INTERVAL '24 hours'

    ORDER BY ic.token_expires_at ASC
    `,
    [REFRESH_WINDOW_DAYS]
  );

  return result.rows;
}


// ----------------------------------------------------
// Instagram refresh call
// ----------------------------------------------------

async function refreshInstagramToken(token) {
  const url =
    new URL(
      "https://graph.instagram.com/refresh_access_token"
    );

  url.searchParams.set(
    "grant_type",
    "ig_refresh_token"
  );

  url.searchParams.set(
    "access_token",
    token
  );

  const controller =
    new AbortController();

  const timeout =
    setTimeout(
      () => controller.abort(),
      20000
    );

  try {
    const response =
      await fetch(url, {
        method: "GET",
        signal: controller.signal
      });

    const text =
      await response.text();

    let body;

    try {
      body = JSON.parse(text);
    } catch {
      body = {
        raw: text.slice(0, 1000)
      };
    }

    if (
      !response.ok ||
      !body.access_token ||
      !body.expires_in
    ) {
      const error =
        new Error(
          body?.error?.message ||
          `Instagram refresh HTTP ${response.status}`
        );

      error.metaCode =
        body?.error?.code || null;

      error.metaSubcode =
        body?.error?.error_subcode || null;

      error.httpStatus =
        response.status;

      throw error;
    }

    return {
      accessToken:
        body.access_token,

      expiresIn:
        Number(body.expires_in)
    };

  } finally {
    clearTimeout(timeout);
  }
}


// ----------------------------------------------------
// Successful refresh
// ----------------------------------------------------

async function saveSuccessfulRefresh(
  connection,
  newToken,
  expiresIn
) {
  const encrypted =
    encryptToken(newToken);

  const newExpiresAt =
    new Date(
      Date.now() +
      expiresIn * 1000
    );

  const client =
    await pool.connect();

  try {
    await client.query("BEGIN");

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
        reauth_required_at = NULL,
        last_error = NULL

      WHERE id = $6
      `,
      [
        encrypted.ciphertext,
        encrypted.iv,
        encrypted.authTag,
        encrypted.keyVersion,

        newExpiresAt,
        connection.connection_id
      ]
    );

    await client.query(
      `
      INSERT INTO token_refresh_logs (
        instagram_connection_id,
        status,
        previous_expires_at,
        new_expires_at
      )
      VALUES (
        $1,
        'success',
        $2,
        $3
      )
      `,
      [
        connection.connection_id,
        connection.token_expires_at,
        newExpiresAt
      ]
    );

    await client.query("COMMIT");

  } catch (error) {
    await client.query("ROLLBACK");
    throw error;

  } finally {
    client.release();
  }

  return newExpiresAt;
}


// ----------------------------------------------------
// Failed refresh
// ----------------------------------------------------

async function saveRefreshFailure(
  connection,
  error,
  requireReauth = false
) {
  const message =
    String(error.message || error)
      .slice(0, 2000);

  const client =
    await pool.connect();

  try {
    await client.query("BEGIN");

    if (requireReauth) {
      await client.query(
        `
        UPDATE instagram_connections
        SET
          status = 'reauth_required',
          reauth_required_at = NOW(),
          last_error = $1
        WHERE id = $2
        `,
        [
          message,
          connection.connection_id
        ]
      );

    } else {
      // Network/5xx/etc. should not immediately
      // disconnect a customer.
      await client.query(
        `
        UPDATE instagram_connections
        SET
          last_error = $1
        WHERE id = $2
        `,
        [
          message,
          connection.connection_id
        ]
      );
    }

    await client.query(
      `
      INSERT INTO token_refresh_logs (
        instagram_connection_id,
        status,
        previous_expires_at,
        error_message
      )
      VALUES (
        $1,
        'failed',
        $2,
        $3
      )
      `,
      [
        connection.connection_id,
        connection.token_expires_at,
        message
      ]
    );

    await client.query("COMMIT");

  } catch (dbError) {
    await client.query("ROLLBACK");
    throw dbError;

  } finally {
    client.release();
  }
}


// ----------------------------------------------------
// One connection
// ----------------------------------------------------

async function processConnection(connection) {
  const now =
    Date.now();

  const expiresAt =
    new Date(
      connection.token_expires_at
    ).getTime();

  const tokenAgeStart =
    new Date(
      connection.token_last_refreshed_at ||
      connection.connected_at
    ).getTime();

  const tokenAge =
    now - tokenAgeStart;

  console.log(
    "Token refresh candidate:",
    {
      username:
        connection.username,

      expiresAt:
        connection.token_expires_at
    }
  );

  if (expiresAt <= now) {
    console.error(
      "Token already expired:",
      connection.username
    );

    if (!DRY_RUN) {
      await saveRefreshFailure(
        connection,
        new Error(
          "Instagram access token expired before refresh"
        ),
        true
      );
    }

    return;
  }

  if (tokenAge < MIN_TOKEN_AGE_MS) {
    console.log(
      "Skipping token younger than 24 hours:",
      connection.username
    );

    return;
  }

  if (DRY_RUN) {
    console.log(
      "DRY RUN: would refresh:",
      connection.username
    );

    return;
  }

  try {
    const token =
      decryptToken({
        ciphertext:
          connection.token_ciphertext,

        iv:
          connection.token_iv,

        authTag:
          connection.token_auth_tag,

        keyVersion:
          connection.token_key_version
      });

    const refreshed =
      await refreshInstagramToken(token);

    const newExpiresAt =
      await saveSuccessfulRefresh(
        connection,
        refreshed.accessToken,
        refreshed.expiresIn
      );

    console.log(
      "Instagram token refreshed:",
      {
        username:
          connection.username,

        newExpiresAt
      }
    );

  } catch (error) {
    // Meta Graph API code 190 indicates an
    // unusable/expired OAuth access token.
    const requireReauth =
      Number(error.metaCode) === 190;

    await saveRefreshFailure(
      connection,
      error,
      requireReauth
    );

    console.error(
      "Instagram token refresh failed:",
      {
        username:
          connection.username,

        metaCode:
          error.metaCode || null,

        metaSubcode:
          error.metaSubcode || null,

        error:
          error.message,

        reauthRequired:
          requireReauth
      }
    );
  }
}


// ----------------------------------------------------
// Main
// ----------------------------------------------------

async function main() {
  // Prevent overlapping refresh runs.
  const lockClient =
    await pool.connect();

  const lockResult =
    await lockClient.query(
      `
      SELECT
        pg_try_advisory_lock(
          742001234::bigint
        ) AS locked
      `
    );

  if (!lockResult.rows[0].locked) {
    console.log(
      "Another token refresh process is already running."
    );

    lockClient.release();
    return;
  }

  try {
    const candidates =
      await getCandidates();

    console.log(
      `Token refresh candidates: ${candidates.length}`
    );

    for (const connection of candidates) {
      await processConnection(
        connection
      );
    }

  } finally {
    await lockClient.query(
      `
      SELECT
        pg_advisory_unlock(
          742001234::bigint
        )
      `
    );

    lockClient.release();
  }
}


main()
  .catch((error) => {
    console.error(
      "Token refresh process failed:",
      error
    );

    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
