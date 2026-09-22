CREATE TABLE IF NOT EXISTS instagram_delivery_safety (
  instagram_account_id UUID PRIMARY KEY
    REFERENCES instagram_accounts(id)
    ON DELETE CASCADE,

  mode TEXT NOT NULL DEFAULT 'pilot'
    CHECK (mode IN ('pilot','normal')),

  promoted_at TIMESTAMPTZ,

  hourly_dm_limit INTEGER NOT NULL DEFAULT 30
    CHECK (hourly_dm_limit BETWEEN 1 AND 500),

  daily_dm_limit INTEGER NOT NULL DEFAULT 100
    CHECK (daily_dm_limit BETWEEN 1 AND 2000),

  hourly_public_reply_limit INTEGER NOT NULL DEFAULT 0
    CHECK (hourly_public_reply_limit BETWEEN 0 AND 200),

  daily_public_reply_limit INTEGER NOT NULL DEFAULT 0
    CHECK (daily_public_reply_limit BETWEEN 0 AND 500),

  commenter_cooldown_seconds INTEGER NOT NULL DEFAULT 21600
    CHECK (commenter_cooldown_seconds BETWEEN 0 AND 604800),

  circuit_breaker_threshold INTEGER NOT NULL DEFAULT 5
    CHECK (circuit_breaker_threshold BETWEEN 1 AND 20),
  circuit_breaker_pause_minutes INTEGER NOT NULL DEFAULT 60
    CHECK (circuit_breaker_pause_minutes BETWEEN 1 AND 1440),

  paused_until TIMESTAMPTZ,
  pause_reason TEXT,

  consecutive_platform_failures INTEGER NOT NULL DEFAULT 0,
  last_platform_failure_at TIMESTAMPTZ,
  last_success_at TIMESTAMPTZ,

  manual_preflight_confirmed_at TIMESTAMPTZ,
  manual_preflight_confirmed_by UUID
    REFERENCES users(id)
    ON DELETE SET NULL,
  manual_preflight_notes TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO instagram_delivery_safety (instagram_account_id)
SELECT id
FROM instagram_accounts
ON CONFLICT (instagram_account_id) DO NOTHING;

CREATE INDEX IF NOT EXISTS instagram_delivery_safety_paused_idx
ON instagram_delivery_safety (paused_until)
WHERE paused_until IS NOT NULL;
