-- CI-only fixture data. Never run against production.
INSERT INTO workspaces (
  id,
  name,
  status
)
VALUES (
  '00000000-0000-4000-8000-000000000001',
  'CI Workspace',
  'active'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO workspace_subscriptions (
  workspace_id,
  plan_code,
  status,
  current_period_start,
  current_period_end
)
VALUES (
  '00000000-0000-4000-8000-000000000001',
  'free',
  'active',
  date_trunc('month', NOW()),
  date_trunc('month', NOW()) + INTERVAL '1 month'
)
ON CONFLICT (workspace_id) DO NOTHING;

INSERT INTO instagram_accounts (
  id,
  professional_account_id,
  username,
  account_type
)
VALUES (
  '00000000-0000-4000-8000-000000000002',
  'ci-professional-account',
  'ci_instagram_account',
  'BUSINESS'
)
ON CONFLICT (professional_account_id) DO NOTHING;

INSERT INTO instagram_connections (
  workspace_id,
  instagram_account_id,
  token_expires_at,
  status
)
VALUES (
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000002',
  NOW() + INTERVAL '60 days',
  'connected'
)
ON CONFLICT DO NOTHING;


INSERT INTO users (
  id,
  email,
  display_name,
  status
)
VALUES (
  '00000000-0000-4000-8000-000000000003',
  'ci-admin@example.invalid',
  'CI Admin',
  'active'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO workspace_members (
  workspace_id,
  user_id,
  role
)
VALUES (
  '00000000-0000-4000-8000-000000000001',
  '00000000-0000-4000-8000-000000000003',
  'owner'
)
ON CONFLICT (
  workspace_id,
  user_id
) DO NOTHING;

INSERT INTO system_admins (
  user_id
)
VALUES (
  '00000000-0000-4000-8000-000000000003'
)
ON CONFLICT (user_id) DO NOTHING;
