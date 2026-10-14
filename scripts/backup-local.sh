#!/usr/bin/env bash
set -euo pipefail
umask 077
archive_name="secure-transfer-$(date -u +%Y%m%dT%H%M%SZ).enc"
mkdir -p backups
node scripts/init-local.cjs
resume_app() { docker compose --env-file /dev/null -f compose.app.yaml up -d --wait app worker; }
trap resume_app EXIT
docker compose --env-file /dev/null -f compose.app.yaml stop app worker
docker compose --env-file /dev/null -f compose.app.yaml run --rm --no-deps --user root \
  --cap-add DAC_OVERRIDE --cap-add CHOWN \
  -e BACKUP_OWNER_UID="$(id -u)" -e BACKUP_OWNER_GID="$(id -g)" \
  -v "$PWD/backups:/backups" app node scripts/backup.cjs create "/backups/$archive_name"
echo "Backup: backups/$archive_name (encryption key remains in .env.local)"
