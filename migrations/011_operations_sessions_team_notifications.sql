ALTER TABLE user_sessions
  ADD COLUMN IF NOT EXISTS user_agent TEXT,
  ADD COLUMN IF NOT EXISTS ip_address TEXT,
  ADD COLUMN IF NOT EXISTS device_label TEXT;

ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'UTC',
  ADD COLUMN IF NOT EXISTS notification_email TEXT,
  ADD COLUMN IF NOT EXISTS notify_token_expiry BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS notify_failures BOOLEAN NOT NULL DEFAULT TRUE;

CREATE TABLE IF NOT EXISTS workspace_invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
  token_hash TEXT NOT NULL UNIQUE,
  invited_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS workspace_invitations_pending_idx
ON workspace_invitations (workspace_id, expires_at DESC)
WHERE accepted_at IS NULL AND revoked_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS workspace_invitations_pending_email_unique
ON workspace_invitations (workspace_id, LOWER(email))
WHERE accepted_at IS NULL AND revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS workspace_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  notification_type TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info'
    CHECK (severity IN ('info', 'warning', 'critical')),
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  action_url TEXT,
  dedupe_key TEXT,
  read_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS workspace_notifications_dedupe_idx
ON workspace_notifications (workspace_id, dedupe_key)
WHERE dedupe_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS workspace_notifications_unread_idx
ON workspace_notifications (workspace_id, created_at DESC)
WHERE read_at IS NULL;

CREATE TABLE IF NOT EXISTS service_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service_name TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'info'
    CHECK (severity IN ('info', 'warning', 'error', 'critical')),
  event_type TEXT NOT NULL,
  request_id TEXT,
  workspace_id UUID REFERENCES workspaces(id) ON DELETE SET NULL,
  message TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS service_events_recent_idx
ON service_events (created_at DESC);

CREATE INDEX IF NOT EXISTS service_events_severity_idx
ON service_events (severity, created_at DESC);

CREATE INDEX IF NOT EXISTS service_events_workspace_idx
ON service_events (workspace_id, created_at DESC)
WHERE workspace_id IS NOT NULL;
