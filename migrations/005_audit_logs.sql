CREATE TABLE IF NOT EXISTS audit_logs (
  id uuid PRIMARY KEY
    DEFAULT gen_random_uuid(),

  workspace_id uuid
    REFERENCES workspaces(id)
    ON DELETE SET NULL,

  user_id uuid
    REFERENCES users(id)
    ON DELETE SET NULL,

  event_type text NOT NULL,

  target_type text,
  target_id text,

  ip_address text,
  user_agent text,

  metadata jsonb NOT NULL
    DEFAULT '{}'::jsonb,

  created_at timestamptz NOT NULL
    DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS
  audit_logs_workspace_created_idx
ON audit_logs (
  workspace_id,
  created_at DESC
);

CREATE INDEX IF NOT EXISTS
  audit_logs_user_created_idx
ON audit_logs (
  user_id,
  created_at DESC
);

CREATE INDEX IF NOT EXISTS
  audit_logs_event_created_idx
ON audit_logs (
  event_type,
  created_at DESC
);
