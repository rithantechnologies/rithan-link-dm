#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/var/www/rithan-link-dm-api"
cd "$APP_DIR"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this script as root." >&2
  exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Refusing restart: working tree is not clean." >&2
  exit 1
fi

echo "Deploying $(git rev-parse --short HEAD): $(git log -1 --pretty=%s)"
npm run check
npm run migrate

systemctl restart rithan-link-dm.service rithan-link-dm-worker.service
ready=0
for attempt in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:3100/ready >/tmp/rithan-link-dm-ready.json; then
    ready=1
    break
  fi
  sleep 1
done

if [[ "$ready" -ne 1 ]]; then
  systemctl status rithan-link-dm.service --no-pager -l || true
  systemctl status rithan-link-dm-worker.service --no-pager -l || true
  echo "API did not become ready." >&2
  exit 1
fi

cat /tmp/rithan-link-dm-ready.json
echo
curl -fsS https://api.rithantechnologies.com/health
echo
npm run healthcheck
echo "Instagram safety release is live."