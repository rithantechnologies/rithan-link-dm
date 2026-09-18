BEGIN;

-- ============================================================
-- Plans
-- ============================================================

CREATE TABLE IF NOT EXISTS plans (
  code text PRIMARY KEY,

  name text NOT NULL,

  max_instagram_accounts integer NOT NULL
    CHECK (max_instagram_accounts >= 0),

  max_active_automations integer NOT NULL
    CHECK (max_active_automations >= 0),

  monthly_dm_limit integer NOT NULL
    CHECK (monthly_dm_limit >= 0),

  activity_history_days integer NOT NULL
    CHECK (activity_history_days >= 1),

  is_active boolean NOT NULL DEFAULT TRUE,

  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW()
);


-- ============================================================
-- Initial Rithan Link DM plans
-- ============================================================

INSERT INTO plans (
  code,
  name,
  max_instagram_accounts,
  max_active_automations,
  monthly_dm_limit,
  activity_history_days,
  is_active
)
VALUES
  (
    'free',
    'Free',
    1,
    3,
    250,
    7,
    TRUE
  ),
  (
    'starter',
    'Starter',
    1,
    25,
    5000,
    90,
    TRUE
  ),
  (
    'pro',
    'Pro',
    2,
    100,
    25000,
    365,
    TRUE
  )
ON CONFLICT (code)
DO UPDATE SET
  name =
    EXCLUDED.name,

  max_instagram_accounts =
    EXCLUDED.max_instagram_accounts,

  max_active_automations =
    EXCLUDED.max_active_automations,

  monthly_dm_limit =
    EXCLUDED.monthly_dm_limit,

  activity_history_days =
    EXCLUDED.activity_history_days,

  is_active =
    EXCLUDED.is_active,

  updated_at =
    NOW();


-- ============================================================
-- One active subscription/entitlement record per workspace
-- Payment-provider fields stay nullable until billing is added.
-- ============================================================

CREATE TABLE IF NOT EXISTS workspace_subscriptions (
  id uuid PRIMARY KEY
    DEFAULT gen_random_uuid(),

  workspace_id uuid NOT NULL UNIQUE
    REFERENCES workspaces(id)
    ON DELETE CASCADE,

  plan_code text NOT NULL DEFAULT 'free'
    REFERENCES plans(code),

  status text NOT NULL DEFAULT 'active'
    CHECK (
      status IN (
        'active',
        'trialing',
        'past_due',
        'canceled',
        'paused'
      )
    ),

  current_period_start timestamptz NOT NULL,

  current_period_end timestamptz NOT NULL,

  provider text,

  provider_customer_id text,

  provider_subscription_id text,

  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),

  CHECK (
    current_period_end >
    current_period_start
  )
);


CREATE INDEX IF NOT EXISTS
  idx_workspace_subscriptions_plan
ON workspace_subscriptions (
  plan_code
);


CREATE INDEX IF NOT EXISTS
  idx_workspace_subscriptions_status
ON workspace_subscriptions (
  status
);


CREATE UNIQUE INDEX IF NOT EXISTS
  idx_workspace_subscriptions_provider_subscription
ON workspace_subscriptions (
  provider,
  provider_subscription_id
)
WHERE provider_subscription_id IS NOT NULL;


-- ============================================================
-- Fast monthly usage counter.
--
-- dm_logs remains the historical/source-of-truth record.
-- This table will be used for fast quota checks.
-- ============================================================

CREATE TABLE IF NOT EXISTS workspace_usage_monthly (
  workspace_id uuid NOT NULL
    REFERENCES workspaces(id)
    ON DELETE CASCADE,

  period_start date NOT NULL,

  dm_sent_count bigint NOT NULL DEFAULT 0
    CHECK (dm_sent_count >= 0),

  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),

  PRIMARY KEY (
    workspace_id,
    period_start
  )
);


CREATE INDEX IF NOT EXISTS
  idx_workspace_usage_period
ON workspace_usage_monthly (
  period_start
);


-- ============================================================
-- Existing workspaces start on Free.
--
-- This does NOT yet enforce limits, so existing production
-- behavior is not changed by this migration.
-- ============================================================

INSERT INTO workspace_subscriptions (
  workspace_id,
  plan_code,
  status,
  current_period_start,
  current_period_end
)
SELECT
  w.id,
  'free',
  'active',
  date_trunc(
    'month',
    NOW()
  ),
  date_trunc(
    'month',
    NOW()
  ) + INTERVAL '1 month'

FROM workspaces w

ON CONFLICT (workspace_id)
DO NOTHING;


-- ============================================================
-- Create current-month usage rows for existing workspaces.
--
-- We intentionally start the counter at zero here.
-- Before quota enforcement, we will reconcile it against
-- existing dm_logs so historical successful sends this month
-- are not lost.
-- ============================================================

INSERT INTO workspace_usage_monthly (
  workspace_id,
  period_start,
  dm_sent_count
)
SELECT
  w.id,
  date_trunc(
    'month',
    NOW()
  )::date,
  0

FROM workspaces w

ON CONFLICT (
  workspace_id,
  period_start
)
DO NOTHING;


COMMIT;
