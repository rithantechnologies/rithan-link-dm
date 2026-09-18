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
        ic.workspace_id,
        ic.instagram_account_id,
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
      ic.workspace_id,
      ic.instagram_account_id,
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

    await client.query(
      `
      UPDATE workspace_notifications
      SET read_at = COALESCE(read_at, NOW())
      WHERE
        workspace_id = $1
        AND (
          dedupe_key LIKE $2
          OR dedupe_key LIKE $3
        )
      `,
      [
        connection.workspace_id,
        `instagram-token:${connection.connection_id}:%`,
        `instagram-reauth:${connection.connection_id}:%`
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


async function syncTokenNotifications() {
  const result = await pool.query(
    `
    SELECT
      ic.id AS connection_id,
      ic.workspace_id,
      ic.instagram_account_id,
      ic.status,
      ic.token_expires_at,
      ia.username,
      w.notify_token_expiry
    FROM instagram_connections ic
    JOIN instagram_accounts ia
      ON ia.id=ic.instagram_account_id
    JOIN workspaces w
      ON w.id=ic.workspace_id
    WHERE
      ic.status IN ('connected','reauth_required')
      AND w.status='active'
    `
  );

  for (const row of result.rows) {
    if (!row.notify_token_expiry) {
      continue;
    }

    let severity = null;
    let title = null;
    let message = null;
    let dedupeKey = null;

    if (row.status === "reauth_required") {
      severity = "critical";
      title = "Reconnect Instagram";
      message =
        `@${row.username || "Instagram account"} needs to be reconnected before automations can continue.`;
      dedupeKey =
        `instagram-reauth:${row.connection_id}:required`;
    } else if (row.token_expires_at) {
      const days =
        (new Date(row.token_expires_at).getTime() - Date.now()) /
        86400000;

      const threshold =
        days <= 1 ? 1 :
        days <= 3 ? 3 :
        days <= 7 ? 7 :
        days <= 14 ? 14 :
        null;

      if (threshold) {
        severity =
          threshold <= 3
            ? "critical"
            : "warning";
        title = "Instagram token expiring";
        message =
          `@${row.username || "Instagram account"} token expires in about ${Math.max(0, Math.ceil(days))} day(s). Reconnect now to avoid interrupted automations.`;
        dedupeKey =
          `instagram-token:${row.connection_id}:${threshold}`;
      }
    }

    if (!dedupeKey) {
      continue;
    }

    await pool.query(
      `
      INSERT INTO workspace_notifications (
        workspace_id,
        notification_type,
        severity,
        title,
        message,
        action_url,
        dedupe_key
      )
      VALUES (
        $1,
        'instagram_connection',
        $2,
        $3,
        $4,
        '/dashboard/?page=instagram',
        $5
      )
      ON CONFLICT (workspace_id,dedupe_key)
      WHERE dedupe_key IS NOT NULL
      DO UPDATE SET
        severity=EXCLUDED.severity,
        title=EXCLUDED.title,
        message=EXCLUDED.message,
        action_url=EXCLUDED.action_url
      `,
      [
        row.workspace_id,
        severity,
        title,
        message,
        dedupeKey
      ]
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

    await syncTokenNotifications();

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
