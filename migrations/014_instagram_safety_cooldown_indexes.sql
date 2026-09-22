ALTER TABLE instagram_delivery_safety
  ALTER COLUMN commenter_cooldown_seconds
  SET DEFAULT 86400;

UPDATE instagram_delivery_safety
SET commenter_cooldown_seconds = 86400,
    updated_at = NOW()
WHERE commenter_cooldown_seconds = 21600;

CREATE INDEX IF NOT EXISTS dm_logs_account_sent_safety_idx
ON dm_logs (instagram_account_id, sent_at DESC)
WHERE status = 'sent';

CREATE INDEX IF NOT EXISTS public_reply_logs_account_sent_safety_idx
ON public_reply_logs (instagram_account_id, sent_at DESC)
WHERE status = 'sent';
