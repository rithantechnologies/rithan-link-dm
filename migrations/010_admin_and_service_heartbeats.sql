CREATE TABLE IF NOT EXISTS system_admins (
  user_id UUID PRIMARY KEY
    REFERENCES users(id)
    ON DELETE CASCADE,

  created_at TIMESTAMPTZ
    NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS service_heartbeats (
  service_name TEXT PRIMARY KEY,

  heartbeat_at TIMESTAMPTZ
    NOT NULL DEFAULT NOW(),

  metadata JSONB
    NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS
  service_heartbeats_heartbeat_idx
ON service_heartbeats (
  heartbeat_at DESC
);
