BEGIN;

CREATE INDEX IF NOT EXISTS
  dm_logs_created_at_idx
ON dm_logs (
  created_at DESC
);

CREATE INDEX IF NOT EXISTS
  public_reply_logs_created_at_idx
ON public_reply_logs (
  created_at DESC
);

CREATE INDEX IF NOT EXISTS
  audit_logs_created_at_idx
ON audit_logs (
  created_at DESC
);

CREATE INDEX IF NOT EXISTS
  instagram_connections_workspace_status_idx
ON instagram_connections (
  workspace_id,
  status,
  connected_at DESC
);

COMMIT;
