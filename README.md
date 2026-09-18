# Rithan Link DM

Rithan Link DM is a multi-tenant Node.js service for Instagram comment-to-DM automations.

A typical flow is:

```text
Instagram comment
  -> Meta webhook
  -> BullMQ
  -> tenant/account lookup
  -> media + keyword match
  -> plan/quota enforcement
  -> private reply DM
  -> optional public reply
```

## Current capabilities

- Instagram Login / Business Login for Instagram
- Comment webhook verification and HMAC validation
- Per-workspace Instagram account ownership
- Media-specific keyword automations
- Private reply DMs and optional public replies
- PostgreSQL-backed audit/activity data
- BullMQ + Redis worker processing
- Per-account send pacing
- Free / Starter / Pro entitlement limits
- Monthly successful-DM quota enforcement
- Activity-history retention by plan
- Public-reply recovery
- Token refresh scheduling
- Session auth, CSRF/origin checks, login rate limiting
- API mutation rate limiting
- Health and readiness endpoints
- Scheduled PostgreSQL backups and verification tooling
- Production health watchdog

## Runtime

Production currently targets Node.js 20.

```bash
npm ci
npm run check
npm test
```

## Local dependencies

You need:

- Node.js 20
- PostgreSQL
- Redis

Copy the example environment file and fill in your own credentials:

```bash
cp .env.example .env
```

Never commit `.env`, access tokens, Meta app secrets, encryption keys, database passwords, or database dumps.

## Database setup

The existing production database is tracked through `schema_migrations`.

For a new empty database, apply the numbered SQL files in order, then baseline them:

```bash
for file in migrations/*.sql; do
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$file"
done

node scripts/migrate.js --baseline-existing
```

After the baseline, future migrations should be applied with:

```bash
npm run migrate
```

The migration runner verifies checksums and refuses drift in already-applied migration files.

## Tests

```bash
npm run check
npm test
```

The suite includes:

- subscription entitlement unit tests
- HTTP/security smoke tests on a temporary API port
- readiness checks for PostgreSQL and Redis
- malformed/oversized request handling
- unauthenticated API rejection
- webhook signature rejection
- rollback-only PostgreSQL tests for plan/account/automation guards

## Backups

Create a PostgreSQL custom-format backup:

```bash
npm run backup
npm run backup:verify
```

Production systemd templates are under `ops/systemd/`. The restore verifier can restore into a disposable database and compare critical table counts against the backup manifest.

## Health endpoints

- `GET /health` — process-level health
- `GET /ready` — PostgreSQL + Redis readiness

The production watchdog additionally checks the public HTTPS endpoint, TLS expiry, queue failures/backlog, backup age, disk usage, and connected Instagram token expiry.

## Deployment notes

Production runs the API and worker as a dedicated unprivileged service user behind Nginx. PostgreSQL, Redis, and the Node API are expected to bind to loopback only.

Before a production deployment:

```bash
npm ci
npm run check
npm test
npm run migrate
npm audit --omit=dev
```

Do not restart production services until those checks pass.

## Repository safety

This repository intentionally excludes:

- `.env` and environment-specific secrets
- `node_modules/`
- PostgreSQL dumps and backup artifacts
- timestamped emergency snapshots created during live maintenance

If a secret is ever committed, rotate it immediately; deleting it from a later commit is not sufficient.
