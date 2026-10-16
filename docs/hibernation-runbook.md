# Rithan Link DM — hibernation, inventory, and restore runbook

Last checked: **2026-10-16 (Asia/Kolkata)** on VPS `srv1632013`.
Project: IG Automation / Rithan Link DM. Repository: `git@github.com:rithantechnologies/rithan-link-dm.git`, branch `main`.
Checkout: `/var/www/rithan-link-dm-api`; service account: `rithanlinkdm`; application Node binary: `/usr/bin/node` (Node 20.20.2 at inventory).
Source baseline before this archival documentation: `678855f6e76d73bec1fe7daec7323f236013727d` on both VPS `main` and GitHub `main`.
See `docs/production-runbook.md` for health checks, security, queues, onboarding, and live deployment.

## Architecture and protected state

- API: `rithan-link-dm.service`, `server.js`, localhost `127.0.0.1:3100`.
- Background Instagram worker: `rithan-link-dm-worker.service`, `worker.js`.
- Nginx site `/etc/nginx/sites-enabled/api.rithantechnologies.com` proxies to port 3100. Expect the IG API hostname to be unavailable after hibernation; do **not** remove/change this host or other Nginx sites as part of the shutdown.
- PostgreSQL database: `rithan_link_dm`, containing customer, connection, automation, subscription and audit state.
- Redis/BullMQ: Instagram queue, deduplication and rate-limit state. Review pending jobs before a future restart.
- Private production config: `/var/www/rithan-link-dm-api/.env`; template: `.env.example`. Never print or commit secrets.
- PostgreSQL archives: `/var/www/rithan-link-dm-api/var/backups/postgres/`. They are intentionally ignored by Git; store protected off-server copies under an approved backup policy if long-term preservation is needed. Do not delete/move the live database, queue, `.env`, archive directory or other workloads.
- The underlying PostgreSQL, Redis, Nginx, and VPS may be shared. Never stop their shared system services just to hibernate IG.

## Exact systemd inventory

The `ops/systemd/` tree contains snapshots of the **12 live IG-specific units** plus the two effective API/worker hardening drop-ins captured on 2026-10-16.

Persistent units:
- `rithan-link-dm.service` — API, base unit has `Restart=always`.
- `rithan-link-dm-worker.service` — worker, base unit has `Restart=always`.

Five scheduling pairs (timer and corresponding oneshot service):
- `rithan-link-dm-backup.timer` / `rithan-link-dm-backup.service` — daily database backup.
- `rithan-link-dm-health-check.timer` / `rithan-link-dm-health-check.service` — periodic health monitoring; **health-check service wants API and worker**, so its timer must be stopped.
- `rithan-link-dm-public-recovery.timer` / `rithan-link-dm-public-recovery.service` — public-reply retry/recovery approximately every ten minutes.
- `rithan-link-dm-token-refresh.timer` / `rithan-link-dm-token-refresh.service` — daily Instagram token refresh.
- `rithan-link-dm-session-cleanup.timer` / `rithan-link-dm-session-cleanup.service` — daily session cleanup.

The base API/worker unit files say `User=root`, but effective `/etc/systemd/system/rithan-link-dm{,-worker}.service.d/hardening.conf` overrides them to `User=rithanlinkdm` with hardening. **Always deploy the drop-ins with the units; never run them as root.**

## Verified preservation checkpoint

On 2026-10-16, before stopping anything, a fresh PostgreSQL `pg_dump` was created (with temporary retention override to preserve older archives), and `npm run backup:verify` confirmed checksum and archive readability:

```text
var/backups/postgres/rithan-link-dm-2026-10-16T06-32-11-603Z.dump
SHA-256 e04b0c06f9604f2528546c245df107b7a73f66310ec68ba9b90cf41535ce9e40
Size 152882 bytes
```

This verifies archive structure/checksum, **not** a full restoration drill. Data archives and secret config were *not* committed to Git. Existing older archives were retained. Review backup retention independently: the default script removes backups older than its retention period; to preserve old archives for a manual backup run, use `POSTGRES_BACKUP_RETENTION_DAYS=36500 npm run backup`.

## Operator-safe hibernation procedure (requires service-management privileges)

1. Confirm the Git checkout has no tracked modifications, fetch from GitHub, and confirm your intended `main` commit is deployed. Verify a current, readable PostgreSQL archive. Note any customer-facing downtime (IG webhooks and dashboards will stop).
2. Disable all **five IG timers** first, to prevent scheduled jobs from triggering a restart or writing application state:
   ```bash
   sudo systemctl disable --now \
     rithan-link-dm-backup.timer \
     rithan-link-dm-health-check.timer \
     rithan-link-dm-public-recovery.timer \
     rithan-link-dm-session-cleanup.timer \
     rithan-link-dm-token-refresh.timer
   ```
3. Gracefully stop and disable both long-running IG processes (systemd manual stop suppresses their `Restart=always` policy):
   ```bash
   sudo systemctl disable --now rithan-link-dm-worker.service rithan-link-dm.service
   ```
4. Check for an IG-specific oneshot still running, especially health check; if needed stop **only** that IG unit, not PostgreSQL/Redis/Nginx:
   ```bash
   systemctl list-units 'rithan-link-dm*' --all --no-pager
   sudo systemctl stop rithan-link-dm-health-check.service
   ```
5. Verify the API, worker and all five timers are inactive and disabled; port 3100 is no longer listening, and another host reboot will not automatically start these disabled units:
   ```bash
   systemctl is-active rithan-link-dm.service rithan-link-dm-worker.service
   systemctl is-enabled rithan-link-dm.service rithan-link-dm-worker.service
   systemctl list-timers --all 'rithan-link-dm*'
   ss -ltnp '( sport = :3100 )'
   ```

Do **not** force-mask these locally installed `/etc/systemd/system/` unit files: force masking can overwrite the original unit definition. Do not `kill -9`, wipe queues, stop the shared database, delete systemd definitions, or interfere with other VPS projects. Review any other operational tooling that might explicitly start the IG services; disabling timer/boot activation does not prohibit a privileged person from manually starting them.

## Resume / redeploy later (only on explicit request)

1. Review customer authorization, Meta app/token validity, retained Redis jobs, and any stale automatic replies **before** starting the worker. Recheck current dependencies, security settings, and backup/restore availability. Make a fresh protected backup before schema migrations.
2. Use Git to fetch and select the approved production commit (do not overwrite server-only secrets or archives). Install the Node version compatible with `package.json` (Node >=20, <23); ensure PostgreSQL/Redis dependencies are running without restarting unrelated workloads.
3. For a newly rebuilt host, install the saved `ops/systemd/*.service`, `ops/systemd/*.timer`, plus **both** `ops/systemd/rithan-link-dm*.service.d/hardening.conf` drop-ins to matching paths under `/etc/systemd/system/`. Confirm the effective service user is `rithanlinkdm`; `sudo systemctl daemon-reload`. The existing VPS already has those units; do not overwrite them unnecessarily.
4. Restore/provision `.env` from the protected secret store (use `.env.example` for names only). Do not restore from Git; the real credentials are never in Git.
5. In the checkout run `npm ci`, `npm run check`, `npm test`, `npm audit --omit=dev --audit-level=high`, and after reviewing compatibility `npm run migrate`. Follow the production runbook's release gates.
6. If approved to reopen the API, `sudo systemctl enable --now rithan-link-dm.service`; verify `curl -fsS http://127.0.0.1:3100/ready` and public HTTPS. **Do not** immediately enable worker/recovery/token timers if there may be outdated queued work or expired Meta credentials.
7. Once queued jobs/Meta permissions have been reviewed and customer delivery is explicitly approved, enable and start `rithan-link-dm-worker.service` and selectively enable relevant IG timers; monitor errors, activity, delivery and health. Record the final code SHA and effective unit configurations.

## Git / audit rules

- Repo source and systemd templates belong in Git. Git checkout and GitHub `main` should point to the same approved SHA, with a clean worktree.
- **No secrets, database dumps, access tokens, Redis snapshots or customer data in Git.** Preserve them through private backups and credential management.
- Document the final state, exact SHA, backup time/verification, timers disabled and outstanding operational limitations in the shutdown handoff.

## 2026-10-16 execution handoff — shutdown NOT completed

Git and preservation work completed: fresh 2026-10-16 PostgreSQL archive (checksum and archive-readability verified), live systemd units and hardening snapshotted in Git, original deployment code unmodified.

**VPS privilege blocker:** the connected `cashledger` Desktop Commander user does not have noninteractive authorization for `systemctl disable --now`. The requested shutdown was attempted only at the timer-disable stage and was rejected with `Access denied as the requested operation requires interactive authentication`. No processes were force-killed or systemd configurations modified.

After the failed attempt, rechecked live state: API **active/enabled** on localhost port 3100, worker **inactive/enabled**, all five IG timers **active/enabled**. The service remains **not hibernated** until an authorized administrator executes the procedure above and confirms the final states. Do not interpret the Git archival commit as proof that the service was shut down.
