# Local pilot operations

Runbook for the v0.6.0 local application. [README](../README.md) introduces the product, [implementation](IMPLEMENTATION.md) maps the runtime/API, and [delivery status](DELIVERY_STATUS.md) owns readiness and remaining work. The procedures below are operator actions to choose deliberately, not a claim that production infrastructure is provisioned.

## Choose the correct stack

For a new filesystem installation, use `compose.app.yaml`. For private S3, use both `compose.app.yaml` and `compose.s3.yaml` with ignored `.env.s3`. This existing development workspace uses the S3 overlay and `http://secure-transfer.localhost:3081`; a new clone defaults to filesystem storage and `http://localhost:3081`. Both capture email locally at port 8025.

Before updating an existing installation, identify its current stack and take a backup with that stack. Preserve `.env.local`, `.env.s3`, the Garage configuration, retained encryption/backup keys and named volumes. Initializers preserve existing credentials; they do not provision real email, payment accounts, production keys or an administrator automatically. Keep S3 configured while any live or retained object references need it. Do not switch to the base stack merely because a README example uses filesystem storage.

`compose.local.yaml` is only the separate preview at port 3080. The root `docker-compose.yml` is a legacy template and is not compatible with the current setup instructions. `Deployment.yaml` is an incomplete application-only template, not a turnkey production deployment.

## Health and recovery

`/health` checks the process; `/ready` checks database and storage. Workspace administrators can call `/api/operations` with the bearer token and `X-Organization-ID` to see scan/deletion counts, notification backlog and recent worker heartbeat. Inspect `docker compose --env-file /dev/null -f compose.app.yaml logs --tail=100 app worker scanner`. Scan failures keep files quarantined; notification and scan jobs carry leases and exponential retries. Deletion tombstones persist until object deletion succeeds. Quota reservations are embedded in organization records and reconciled after one hour if they have no live transfer or active/finalizing/cancelling upload.

If downloads stay quarantined, check scanner health, signature updates and worker logs. Do not bypass scanning to recover availability. ClamAV alerts on encrypted archives/documents and exceeded scan limits; such files are blocked. Scanner temporary extraction uses a memory filesystem. Keep the signature volume and review FreshClam updates; a clean verdict does not guarantee a file is harmless.

## Encrypted snapshots

Run `bash scripts/backup-local.sh`. It stops application and worker writes, creates an authenticated encrypted archive under ignored `backups/`, and restarts the services. Metadata, organizations, usage/audit history, payment orders/events, active upload sessions, chunks and encrypted objects are included. App sessions, native-download grants/tickets and OTP challenges are excluded. New STBK2 snapshots use framed libsodium secretstream with authenticated finality; STBK1 snapshots remain readable. Protect and separately back up `.env.local`, including `BACKUP_KEY` and all retained encryption keys. Losing the keys makes the archive or files unreadable. Snapshot retention/offsite copies require an operator policy; this script is not a scheduled offsite backup service.

Restore only into a **new** database prefixed `restore_` and an empty storage destination. Example filesystem drill:

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

The rotation command authenticates each current file/part and rewraps root, chunk and active-upload keys. For a large dataset, pause writes and run one rotation process after taking a snapshot. It can resume after interruption. Keep prior keys for older backups; never delete keys solely because current files have been rewrapped. This local keyring is not a managed KMS. The earlier CBC prototype format needs an explicit offline migration after the actual historical key/data inventory is known.

## Release and rollback

CI requires syntax, core tests, Mongo-backed security/lifecycle/restore tests, clean dependency audit, image build, live SMTP/ClamAV smoke and browser checks for filesystem and S3 storage. Release only reviewed commits with version tags. Preserve the image digest, `.env.local`, `.env.s3` and Garage configuration when applicable, archive, and current schema before changes. Rollback requires compatible database/storage snapshots and retained keys: v0.2.0 does not understand wrapped-key files or quarantine states, and v0.3.0 does not understand S3 references, and v0.4.0 cannot read segmented files or STBK2 snapshots. Do not run an old image against an incompatible database. Restore into a new destination and validate downloads before changing runtime pointers.

Before external deployment: rotate exposed provider credentials, use authenticated services and HTTPS, integrate managed keys/object storage, rehearse actual infrastructure recovery/rollback, measure load under an agreed profile, establish alerting and support ownership, and obtain independent security review. `Deployment.yaml` is a single-instance app template; it does not provision a production worker/scanner/database or secrets.

## Private S3 storage and migration (v0.4.0)

The default stack still uses filesystem storage. To add the private local Garage service, generate ignored S3 credentials and configuration, then use the S3 overlay:

```bash
node scripts/init-s3.cjs
docker compose --env-file .env.s3 -f compose.app.yaml -f compose.s3.yaml up -d --build --wait
```

Garage's S3, administration and RPC ports have no host bindings. The single-node development service stores ciphertext on its own persistent volume. It has no replica redundancy. Production storage requires an operator-managed private bucket, authenticated TLS endpoints and reviewed access/backup policies. The adapter uses explicit configured credentials and does not use ambient AWS profiles.

Old transfers continue to read from their filesystem backend. A migration authenticates the source, copies ciphertext, verifies identical destination bytes and authentication, then changes the transfer's backend. A conflicting destination aborts the migration. Rerunning skips completed records. Source copies remain tracked and are deleted with the transfer; keep the original filesystem volume accessible while these retained references exist. Startup and readiness check every backend required by active transfer metadata. Storage endpoint, bucket, prefix and the original filesystem path must stay stable for their referenced objects.

For a maintenance migration, take a snapshot, pause app/worker writes, and run one migration process at a time:

```bash
bash scripts/backup-local.sh
docker compose --env-file .env.s3 -f compose.app.yaml -f compose.s3.yaml stop app worker
docker compose --env-file .env.s3 -f compose.app.yaml -f compose.s3.yaml run --rm --no-deps app node scripts/migrate-storage.cjs s3
docker compose --env-file .env.s3 -f compose.app.yaml -f compose.s3.yaml up -d --wait app worker
```

To reverse, use `filesystem` as the migration target while S3 remains configured. Set `STORAGE_DRIVER=filesystem` in ignored `.env.s3` and retain the overlay until all S3 references/copies have expired or been deleted. Running the base stack alone while live S3 references exist fails startup rather than pretending storage is ready. Verified retained copies require their original backing store for deletion, so this compatibility period does not yet remove every shared-volume dependency. After old transfers expire, a fully S3 deployment can use independent writable scratch directories for the otherwise unused filesystem fallback.

`backup-local.sh` detects whether the running app has S3 configured and resumes that same stack, including after reverse migration to filesystem storage. An explicit `s3` or `filesystem` stack argument is required when the app is stopped; use `s3` whenever the S3 overlay is still needed. Archives contain ciphertext from either backend and restore each transfer into the selected destination backend, without carrying source-copy references into the restored database. Restore targets must be empty. To restore to S3, use an empty bucket/prefix and the S3 overlay; do not reuse a live application's object prefix. Keep `.env.s3` and `secrets/garage.toml` with the protected operational configuration so the existing Garage volume remains accessible.

The SDK uses multipart upload with one buffered 5 MB part per upload. Interrupted multipart jobs are aborted; the worker also sweeps abandoned multipart uploads older than one hour. Ciphertext listing/orphan reconciliation runs every minute, rather than every queue tick. API downloads authenticate the full manifest and each bounded part before releasing plaintext. Single byte ranges support resume; whole-file buffering is restricted to bounded legacy files. AWS SDK optional checksums are configured for S3 compatibility; AES-GCM remains mandatory for file authentication.

## Enterprise workspace operations (v0.5.0)

The application still defaults to a 10 MiB upload ceiling, with the included ClamAV stream capped at 25 MiB. Upload/scanner caps must both be configured and validated before increasing acceptance. See [large-file formats, scanner contract and measured limits](LARGE_FILES.md). Never release a file by manually changing its quarantined status. Billing/notification maintenance and cleanup run independently of long scan jobs; scan leases and heartbeats renew while inspecting. Restarting interrupts in-flight work, which recovers from persisted leases/offsets.

No platform administrator email is enabled by default on a new installation. This development workspace explicitly uses `admin@secure-transfer.localhost` at `http://secure-transfer.localhost:3081`, with OTP delivered to Mailpit at `http://localhost:8025`. Run `node scripts/configure-admin.cjs YOUR_OPERATOR_EMAIL`, recreate app/worker, and sign in as that email. `ADDRESS --remove` revokes a grant. The command changes only the allowlist in ignored `.env.local`; it never prints keys. Keep allowlist changes in your operator change log. Platform operators can inspect client metadata and aggregate analytics, not file plaintext. Manual subscription changes require a current revision, a reason and sufficient quota/seats. Paid subscriptions are controlled by provider reconciliation; platform access suspension is a separate audited control and does not cancel provider charges.

Payment configuration defaults off. [Billing operations](BILLING.md) describes test/live separation, catalog terms, signed events, authenticated reconciliation, unresolved order handling, and refund/accounting limitations. No merchant sandbox account or commercial pricing has been provided. The Compose worker has outbound networking for provider/HTTPS scanner calls, while MongoDB stays on the private backend network. Configure `APP_URL` in `.env.local` when using a real HTTPS endpoint; Compose no longer overrides it.

The native-download handoff sets a file-only HttpOnly cookie, expiring with the transfer, so the browser can resume beyond the one-hour app session. Explicit logout revokes associated grants. Download links still recheck revocation, current roles and billing access. These credentials are never archived. Audit exports accept UUID and deterministic event IDs, with bounded cursor pagination. Gross recorded payment totals exclude test data, but do not reconcile refunds, disputes or fees.

For release verification, run both UI suites plus all Mongo-backed suites; set `TEST_S3=true` for real Garage tests. S3 coverage now includes segmented migration, key rotation and restore to both backends. The published 1 GiB benchmark uses a byte-counting inspection fixture, not ClamAV. Do not treat its throughput as malware-scanning capacity or its ratio as typical.

MongoDB's Compose and CI file-descriptor limit is explicitly 64,000, following [MongoDB resource-limit guidance](https://www.mongodb.com/docs/manual/reference/ulimit/). Repeated isolated restore/index-build tests exhausted a host-inherited 1,024-descriptor default and caused a local database restart; do not inherit that low limit for a growing metadata set. Recreate the container to apply changed limits while preserving the database volume. Check `docker compose ... exec -T mongo sh -c 'ulimit -n'`. Test runs have bounded timeouts and close HTTP fixtures during teardown so an interrupted dependency does not leave a failed test process running indefinitely.

## Compression operations (v0.6.0)

Use Node 24.19+ in the 24.x line. New `stp1`/`zstd` part codec IDs are authenticated by the existing GCM/manifest format. Keep v0.6.0 or later available when restoring snapshots that contain them; old v0.5.0 code does not implement these readers. Existing old files/backups remain readable in v0.6.0. Migrations and key rotation preserve explicit codec IDs and verify originals. Retain the pre-upgrade encrypted snapshot for rollback to an empty recovery destination; never overwrite a live object prefix/database.

Private compression jobs omit recipients and notifications. Restore jobs reserve both the archive's logical bytes and the reconstructed original. Encrypted staging parts and their lease/checkpoint survive scanner outages; only a verified inspected child is published. Cancellation marks staged work for cleanup and releases its reservation. Invalid archives are blocked; scanner/infrastructure errors stay quarantined for retry. Inspect job status through `/api/file/:id/compression`; do not bypass inspection by changing statuses manually.

Original download analytics and complete archive-export body bytes are separate. Upload payload counters cover received file-chunk bodies, including parsed retries, not TLS/API overhead or billing quotas. Native grants are scoped to a file/representation and revoked on explicit logout. Original ranges still resume; generated exports restart after interruption. `.stc` and `.gz` exports contain plaintext compressed data, never server keys, and are not encrypted archives. See [compression operations and offline output limits](COMPRESSION.md).

## Verification

These commands verify code/configuration; they do not close the external gates in [delivery status](DELIVERY_STATUS.md). The canonical automated sequence is [the CI workflow](../.github/workflows/node.js.yml). Test counts recorded in release reviews are historical evidence, not a substitute for running checks on changed code.

For local source/UI checks:

```bash
npm ci --ignore-scripts
npm run check
npm run check:secrets
npm test
npx playwright install chromium
npm run test:ui
```

On Linux, Chromium also needs its system dependencies; the CI runner uses `npx playwright install --with-deps chromium`. The UI/race suites use controlled API fixtures. Packaged browser tests need the real app, scanner, database and Mailpit running.

The UI fixture uses [Playwright's clock](https://playwright.dev/docs/clock), installed before application timers are created, to separate manual refresh/retry and session expiry from automatic polling. It pauses time and drains an in-flight refresh before manual transitions; separate checks advance time to verify automatic recovery and background expiry. Normal timers resume for the other workflows. Keep both paths covered when changing the fixture; a real delay, force click or test rerun does not resolve this ordering dependency. The application still polls normally every five seconds.

Rebuild application/worker images after changing server source, so a container test does not accidentally exercise an old image. With the filesystem stack running, use its private MongoDB rather than assuming a host port exists:

```bash
docker compose --env-file /dev/null -f compose.app.yaml run --rm --no-deps --user root \
  -v "$PWD/test:/app/test:ro" -e TEST_MONGO_URI=mongodb://mongo:27017 app npm run test:integration
docker compose --env-file /dev/null -f compose.app.yaml exec -T app node < scripts/smoke.cjs
BROWSER_STORAGE=filesystem npm run test:browser
```

With the S3 overlay already running:

```bash
docker compose --env-file .env.s3 -f compose.app.yaml -f compose.s3.yaml run --rm --no-deps --user root \
  -v "$PWD/test:/app/test:ro" -e TEST_MONGO_URI=mongodb://mongo:27017 \
  -e TEST_S3=true -e TEST_COMPRESSION_STORAGE=s3 app npm run test:integration
docker compose --env-file .env.s3 -f compose.app.yaml -f compose.s3.yaml exec -T app node < scripts/smoke.cjs
BROWSER_STORAGE=s3 npm run test:browser
bash scripts/backup-local.sh s3
```

The integration suites use isolated temporary databases/object prefixes and clean up only their test resources. `TEST_S3=true` enables real Garage adapter/migration/recovery cases; `TEST_COMPRESSION_STORAGE=s3` additionally runs private compression/restore integration cases through S3. Host-side integration is possible with `TEST_MONGO_URI` pointing to a separately provisioned test database; Compose MongoDB intentionally has no host port. Use a disposable local pilot for smoke/browser workflows, which create identities, workspaces and transfers through the real app. Browser output under `test-results/` is ignored.

The smoke script checks real local email, ClamAV clean/EICAR inspection, byte-exact recipient download and revocation. `test:browser` runs both the existing client workflows and compression/download/send/restore coverage. Backup/migration/key-rotation correctness is exercised in integration; an actual production restore drill and offsite policy are separate operator acceptance work.

For a documentation-only change, check Markdown links/anchors, cited source paths, configuration/command accuracy, whitespace and tracked secrets. Do not restart the pilot, change its keys or claim new runtime test evidence solely because prose changed. Repository CI still runs its configured checks when the documentation PR is opened.
