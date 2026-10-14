# Local pilot operations

## Health and recovery

`/health` checks the process; `/ready` checks database and storage. Workspace administrators can call `/api/operations` with the bearer token and `X-Organization-ID` to see scan/deletion counts, notification backlog and recent worker heartbeat. Inspect `docker compose --env-file /dev/null -f compose.app.yaml logs --tail=100 app worker scanner`. Scan failures keep files quarantined; notification and scan jobs carry leases and exponential retries. Deletion tombstones persist until object deletion succeeds. Quota reservations are embedded in organization records and reconciled after one hour if they have no live transfer.

If downloads stay quarantined, check scanner health, signature updates and worker logs. Do not bypass scanning to recover availability. ClamAV alerts on encrypted archives/documents and exceeded scan limits; such files are blocked. Scanner temporary extraction uses a memory filesystem. Keep the signature volume and review FreshClam updates; a clean verdict does not guarantee a file is harmless.

## Encrypted snapshots

Run `bash scripts/backup-local.sh`. It stops application and worker writes, creates an authenticated encrypted archive under ignored `backups/`, and restarts the services. Metadata, organizations, usage/audit history and encrypted objects are included. Tokens and OTP challenges are excluded. Protect and separately back up `.env.local`, including `BACKUP_KEY` and all retained encryption keys. Losing the keys makes the archive or files unreadable. Snapshot retention/offsite copies require an operator policy; this script is not a scheduled offsite backup service.

Restore only into a **new** database prefixed `restore_` and an empty storage directory. Example local drill:

```bash
docker compose --env-file /dev/null -f compose.app.yaml run --rm --no-deps --user root \
  --cap-add DAC_OVERRIDE \
  -v "$PWD/backups:/backups:ro" -v secure-transfer-restore-drill:/restore \
  -e STORAGE_DIR=/restore app node scripts/backup.cjs restore \
  /backups/CHOOSE-YOUR-ARCHIVE.enc restore_manual_drill
```

The archive is authenticated before any restore writes. Restore then verifies each file's authenticated decryption. A failed restore destination must be investigated/discarded manually; retries require a new empty destination. The test suite runs an isolated restore drill without replacing application data. The backup wrapper runs a temporary root process with DAC_OVERRIDE and CHOWN capabilities to read the app-owned volume and write the host-owned backup directory, then assigns the encrypted archive to the host user with mode 0600. A root-run manual restore needs object ownership adjusted to the app user (UID 1000) before switching runtime pointers. Do not point the live app at the restored database until its data, keys and ownership are reviewed.

## Key rotation

Add a fresh independent key to `ENCRYPTION_KEYS` (a JSON object of key ID to 64-character hex value) in ignored `.env.local`, preserving `ENCRYPTION_KEY` for legacy GCM files. Set `ENCRYPTION_KEY_ID` to the new ID, then rebuild/recreate application and worker. New files use random per-file keys wrapped by the selected key.

```bash
docker compose --env-file /dev/null -f compose.app.yaml run --rm --no-deps app node scripts/rotate-keys.cjs
```

The rotation command authenticates each current object and rewraps its data key. It can resume after interruption. Keep prior keys for older backups; never delete keys solely because current files have been rewrapped. This local keyring is not a managed KMS. The earlier CBC prototype format needs an explicit offline migration after the actual historical key/data inventory is known.

## Release and rollback

CI requires syntax, core tests, Mongo-backed security/lifecycle/restore tests, clean dependency audit, image build, live SMTP/ClamAV smoke and browser checks. Release only reviewed commits with version tags. Preserve the image digest, `.env.local`, archive, and current schema before changes. For this local v0.3.0 pilot, rollback requires a compatible database/storage snapshot and retained keys: v0.2.0 does not understand new wrapped-key files or quarantine states. Do not run the old image against the migrated database. Restore into a new destination and validate downloads before changing runtime pointers.

Before external deployment: rotate exposed provider credentials, use authenticated services and HTTPS, integrate managed keys/object storage, rehearse actual infrastructure recovery/rollback, measure load under an agreed profile, establish alerting and support ownership, and obtain independent security review. `Deployment.yaml` is a single-instance app template; it does not provision a production worker/scanner/database or secrets.
