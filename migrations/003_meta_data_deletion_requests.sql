CREATE TABLE IF NOT EXISTS meta_data_deletion_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  confirmation_code TEXT NOT NULL UNIQUE,

  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (
      status IN (
        'pending',
        'completed',
        'failed'
      )
    ),

  deleted_accounts_count INTEGER NOT NULL DEFAULT 0,

  error_message TEXT,

  requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS
  meta_data_deletion_requests_status_idx
ON meta_data_deletion_requests (
  status,
  requested_at DESC
);
