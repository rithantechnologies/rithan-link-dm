CREATE TABLE IF NOT EXISTS public_reply_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  comment_id TEXT NOT NULL UNIQUE,

  instagram_account_id UUID NOT NULL
    REFERENCES instagram_accounts(id)
    ON DELETE CASCADE,

  automation_id UUID
    REFERENCES automations(id)
    ON DELETE SET NULL,

  reply_comment_id TEXT,

  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (
      status IN (
        'pending',
        'sending',
        'sent',
        'failed',
        'skipped'
      )
    ),

  attempt_count INTEGER NOT NULL DEFAULT 0,

  failure_message TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS
  public_reply_logs_account_idx
ON public_reply_logs (
  instagram_account_id,
  created_at DESC
);

CREATE INDEX IF NOT EXISTS
  public_reply_logs_status_idx
ON public_reply_logs (
  status,
  created_at DESC
);
