CREATE TABLE IF NOT EXISTS user_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  user_id UUID NOT NULL
    REFERENCES users(id)
    ON DELETE CASCADE,

  active_workspace_id UUID
    REFERENCES workspaces(id)
    ON DELETE SET NULL,

  session_token_hash TEXT NOT NULL UNIQUE,

  expires_at TIMESTAMPTZ NOT NULL,

  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS
  user_sessions_user_idx
ON user_sessions (
  user_id,
  created_at DESC
);

CREATE INDEX IF NOT EXISTS
  user_sessions_active_idx
ON user_sessions (
  session_token_hash
)
WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS
  user_sessions_expiry_idx
ON user_sessions (
  expires_at
)
WHERE revoked_at IS NULL;
