BEGIN;

ALTER TABLE workspace_usage_monthly
ADD COLUMN IF NOT EXISTS dm_reserved_count bigint
NOT NULL DEFAULT 0
CHECK (dm_reserved_count >= 0);

COMMIT;
