# Rithan Link DM Production Runbook

## Service map

- API: `rithan-link-dm.service`
- Worker: `rithan-link-dm-worker.service`
- PostgreSQL: durable product, auth, audit, notification and operational state
- Redis/BullMQ: Instagram webhook work queue and rate-limit state
- Nginx: TLS termination and reverse proxy
- Public API: `https://api.rithantechnologies.com`

## Normal health checks

```bash
systemctl is-active rithan-link-dm.service rithan-link-dm-worker.service
curl -fsS http://127.0.0.1:3100/health
curl -fsS http://127.0.0.1:3100/ready
npm run healthcheck
```

Expected readiness is database=ok and redis=ok. The production health check also validates public HTTPS, TLS lifetime, queue backlog/age, retained failed jobs, backup age, disk usage and Instagram token lifetime.

## Deploy

```bash
git status --short
npm ci
npm run check
npm test
npm audit --omit=dev --audit-level=high
npm run migrate
```

Only after all gates pass:

```bash
systemctl restart rithan-link-dm.service rithan-link-dm-worker.service
curl -fsS http://127.0.0.1:3100/ready
```

Confirm the worker heartbeat in Admin > System and verify the public `/health`, `/ready`, `/dashboard/` and `/admin/` surfaces.

## Queue incident

Admin > System shows waiting, active, delayed, failed and oldest-pending age. Failed BullMQ jobs are retained as dead letters and can be retried from Admin.

If backlog age grows while the worker heartbeat is fresh, inspect worker logs and Redis before restarting anything:

```bash
journalctl -u rithan-link-dm-worker.service -n 200 --no-pager
redis-cli PING
```

Use the Admin retry action only after the underlying error is understood. Delivery retries are auditable.

## Instagram token / reconnect incident

Token refresh runs automatically. Customers receive in-product warnings at approximately 14, 7, 3 and 1 days before expiry. A token that Meta marks unusable becomes `reauth_required` and creates a critical reconnect notification.

Do not manually edit encrypted token columns. Have the workspace owner/admin complete the normal Instagram reconnect flow. Successful refresh/reconnect resolves prior token warnings.

## Customer delivery failure

1. Check Admin > Errors for the failure message/code.
2. Check Admin > System for queue health and worker heartbeat.
3. Fix the underlying account/token/platform issue.
4. Use Retry on the failed DM/public reply.
5. Confirm the activity changes to sent/completed.

When a job exhausts every BullMQ attempt, the workspace receives a critical in-product notification if failure notifications are enabled.

## Database backup and restore

A systemd timer creates PostgreSQL custom-format backups and verifies them.

```bash
systemctl status rithan-link-dm-backup.timer
npm run backup
npm run backup:verify
```

For a restore drill, use a disposable database only:

```bash
npm run backup:verify -- --database <disposable_database_name>
```

Never restore over production during a drill. Record the drill date, backup filename, verification result and restore duration.

## Redis durability

Redis must use persistence in production. Check:

```bash
redis-cli CONFIG GET appendonly save dir dbfilename
```

AOF is preferred in addition to RDB snapshots for queue durability. If Redis data is lost, Meta may retry webhooks that were not acknowledged, but already-acknowledged queued work can be lost; therefore Redis persistence is part of the production recovery boundary.

## Session/security incident

Customers can review device/browser, IP, created/last-seen timestamps and revoke individual sessions. Password changes revoke all other sessions.

System-admin access is enforced server-side. Workspace mutations use Owner/Admin policy; Members are read-only.

For suspected account compromise:
1. Change password.
2. Revoke all other sessions.
3. Review audit events.
4. Rotate affected external credentials if necessary.

## Alerting

The five-minute health timer records warning/critical events in `service_events`. If `OPS_ALERT_WEBHOOK_URL` is configured, the same health payload is pushed to the external operations channel.

Important signals:
- API/readiness unavailable
- worker heartbeat stale
- queue failed jobs
- queue backlog or old pending job
- stale/missing backup
- high disk usage
- TLS expiry
- Instagram token expiry/reauth

## Rollback

Prefer reverting the application commit and restarting API/worker. Database migrations are forward-only: do not casually delete columns/tables to roll back application code. New schema should remain backward-compatible for at least one release when possible.

After rollback:
```bash
npm run check
npm test
curl -fsS http://127.0.0.1:3100/ready
```

Then verify Admin > System, one customer dashboard, Instagram connection status and worker heartbeat.

## Customer onboarding and approval

Early Access onboarding is admin-approved.

Customer flow:

1. Customer opens the dashboard sign-in page and chooses **Request an account**.
2. Customer submits name, work email, workspace/business name and intended use.
3. The request appears in **Admin > Onboarding** as Pending.
4. A system administrator selects the initial plan and chooses **Approve** or **Reject**.
5. Approval atomically creates the workspace, disabled Owner account, workspace membership, subscription entitlement, monthly usage row and one-time account setup token.
6. The admin securely sends the displayed setup link to the customer.
7. The customer opens the link, sets a password of at least 12 characters and activates the account.
8. The one-time setup token is consumed and cannot be reused.
9. The customer signs in and follows the normal Instagram onboarding checklist.

Approved but unclaimed accounts remain disabled. From **Admin > Onboarding > Approved**, use **New setup link** to invalidate any previous unconsumed setup token and issue a new one. This action is blocked after the account has been activated.

Do not send raw passwords to customers. Administrators never need to know the customer's password.

Public access requests are same-origin protected, covered by the global mutation limiter, and additionally capped at 10 newly recorded requests per source IP per hour.

## Instagram customer safety preflight

Do not launch an external customer until `GET /api/instagram/accounts/:id/preflight`
returns `ready: true`.

Before setting `META_EXTERNAL_CUSTOMER_ACCESS_CONFIRMED=true`, verify in the
Meta App Dashboard that the app is Live, the business verification requirement
is satisfied, and the Instagram Login permissions used by this service have the
access level required for third-party customer accounts.

The manual account preflight must also confirm:

1. Instagram Account Status shows no current restriction.
2. Two-factor authentication is enabled.
3. No competing auto-DM/comment automation is connected to the account.

Newly connected accounts automatically receive a pilot safety policy:
- 30 successful private replies per rolling hour.
- 100 successful private replies per rolling day.
- 24-hour cooldown per commenter for the same automation.
- Public automated replies disabled.
- Automatic circuit breaking on rate-limit, auth, permission or restriction errors.
Transient/network errors use delayed retries; permanent Meta errors do not retry.
A safety pause creates a critical workspace notification and service event.
Investigate the original Meta error before using the safety unpause action.

After manual preflight, keep the account in pilot mode for at least 48 hours.
The promotion endpoint refuses promotion if the pilot period is incomplete or
delivery failures occurred. A clean promotion sets 60 DMs/hour and 250/day;
public replies remain disabled until deliberately enabled later.

For the first live campaign, use one account, one post/Reel and one exact-match
keyword. Verify one genuine external comment produces exactly one DM, correct
workspace/activity/usage records, no retry, and no duplicate delivery before
announcing the campaign.
