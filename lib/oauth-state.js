const crypto = require("crypto");
const pool = require("../db");

function hashState(state) {
  return crypto
    .createHash("sha256")
    .update(state)
    .digest("hex");
}

async function createOAuthState(workspaceId) {
  const rawState = crypto.randomBytes(32).toString("base64url");
  const stateHash = hashState(rawState);

  const result = await pool.query(
    `
    INSERT INTO oauth_states (
      state_hash,
      workspace_id,
      expires_at
    )
    VALUES (
      $1,
      $2,
      NOW() + INTERVAL '10 minutes'
    )
    RETURNING id, expires_at
    `,
    [stateHash, workspaceId]
  );

  return {
    state: rawState,
    expiresAt: result.rows[0].expires_at
  };
}

async function consumeOAuthState(rawState) {
  if (!rawState) {
    return null;
  }

  const stateHash = hashState(rawState);

  const result = await pool.query(
    `
    UPDATE oauth_states
    SET consumed_at = NOW()
    WHERE state_hash = $1
      AND consumed_at IS NULL
      AND expires_at > NOW()
    RETURNING
      id,
      workspace_id,
      expires_at,
      consumed_at
    `,
    [stateHash]
  );

  return result.rows[0] || null;
}

module.exports = {
  createOAuthState,
  consumeOAuthState
};
