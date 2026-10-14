#!/usr/bin/env bash
set -euo pipefail
umask 077
compose_command=(docker compose --env-file /dev/null -f compose.app.yaml)
storage_mode="${1:-}"
if [ -z "$storage_mode" ]; then
  app_container="$("${compose_command[@]}" ps -q app)"
  if [ -z "$app_container" ]; then
    echo 'Specify filesystem or s3 when the application is stopped.' >&2
    exit 1
  fi
  storage_mode="$(docker exec "$app_container" node -p "process.env.S3_ENDPOINT ? 's3' : 'filesystem'")"
fi
case "$storage_mode" in
  filesystem) ;;
  s3) compose_command=(docker compose --env-file .env.s3 -f compose.app.yaml -f compose.s3.yaml) ;;
  *) echo 'Usage: backup-local.sh [filesystem|s3]' >&2; exit 1 ;;
esac
archive_name="secure-transfer-$(date -u +%Y%m%dT%H%M%SZ).enc"
mkdir -p backups
node scripts/init-local.cjs
resume_app() { "${compose_command[@]}" up -d --wait app worker; }
trap resume_app EXIT
"${compose_command[@]}" stop app worker
"${compose_command[@]}" run --rm --no-deps --user root \
  --cap-add DAC_OVERRIDE --cap-add CHOWN \
  -e BACKUP_OWNER_UID="$(id -u)" -e BACKUP_OWNER_GID="$(id -g)" \
  -v "$PWD/backups:/backups" app node scripts/backup.cjs create "/backups/$archive_name"
echo "Backup: backups/$archive_name ($storage_mode stack; encryption key remains in .env.local)"
