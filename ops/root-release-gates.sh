#!/usr/bin/env bash
set -euo pipefail

APP_DIR="/var/www/rithan-link-dm-api"
BACKUP_ROOT="/var/backups/rithan-link-dm"
BACKUP_DIR="${BACKUP_ROOT}/postgres"
RESTORE_DB="rithan_link_dm_restore_test"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this script as root." >&2
  exit 1
fi

echo "== 1. Backup directory =="
install -d   -o rithanlinkdm   -g rithanlinkdm   -m 700   "${BACKUP_ROOT}"   "${BACKUP_DIR}"

echo "== 2. Backup systemd units =="
install -o root -g root -m 644   "${APP_DIR}/ops/systemd/rithan-link-dm-backup.service"   /etc/systemd/system/rithan-link-dm-backup.service

install -o root -g root -m 644   "${APP_DIR}/ops/systemd/rithan-link-dm-backup.timer"   /etc/systemd/system/rithan-link-dm-backup.timer

systemctl daemon-reload
systemctl enable --now   rithan-link-dm-backup.timer

echo "== 3. Immediate backup =="
systemctl start   rithan-link-dm-backup.service

systemctl show   -p Result   -p ExecMainStatus   rithan-link-dm-backup.service

echo "== 4. Restore drill =="
sudo -u postgres dropdb   --if-exists   "${RESTORE_DB}"

sudo -u postgres createdb   --owner=rithan_link_dm_app   "${RESTORE_DB}"

restore_rc=0

sudo -u rithanlinkdm   env     POSTGRES_BACKUP_DIR="${BACKUP_DIR}"     /usr/bin/node     "${APP_DIR}/scripts/verify-postgres-backup.js"     --database     "${RESTORE_DB}"   || restore_rc=$?

sudo -u postgres dropdb   --if-exists   "${RESTORE_DB}"

if [[ "${restore_rc}" -ne 0 ]]; then
  echo "Restore drill failed." >&2
  exit "${restore_rc}"
fi

echo "== 5. Relevant certificate renewal dry-run =="
certbot renew   --cert-name api.rithantechnologies.com   --dry-run

systemctl reset-failed   certbot.service || true

echo "== 6. Nginx config test =="
nginx -t

echo "== 7. Remove stale trust-proxy test process =="
pkill -f   'node scripts/test-trust-proxy.js'   || true

echo "== 8. Firewall status =="
ufw status verbose || true

echo "== 9. Final schedules =="
systemctl list-timers   'rithan-link-dm-*'   certbot.timer   --all   --no-pager

echo "Release-gate root checks completed."
