# Secure Transfer — v0.4.0 local pilot

Email-verified, encrypted file transfers with team workspaces, role-based access, recipient grants, storage quotas, malware quarantine, retryable notifications, activity export and local billing simulation. Ciphertext can live on a local filesystem or a private S3-compatible service. Built with Node 24, Express, MongoDB and ClamAV, with Garage for optional local S3 storage. This release targets local pilot workflows; production acceptance gates remain open.

## Start

Requires Docker Compose and Node 24. ClamAV's signature database requires an initial image download and roughly 2 GB of scanner memory.

```bash
node scripts/init-local.cjs
docker compose --env-file /dev/null -f compose.app.yaml up -d --build --wait
```

Open **http://localhost:3081**. Email codes and recipient notifications appear at **http://localhost:8025**; this stack does not email external addresses. Keep `.env.local` and the named volumes to preserve your keys and data. The legacy tracked `.env` is no longer loaded or tracked; its prior history still requires provider-side rotation if it contained live credentials.

1. Sign in using an email and the code from the local inbox.
2. Use your personal workspace or create a team. Owners can add administrators, members or viewers. Invited users sign in with their own email and select the workspace.
3. Upload a file up to 10 MB, designate a recipient, and set an expiry. The encrypted file stays quarantined until ClamAV releases it. The worker then emails the recipient with retries if delivery fails.
4. The recipient signs in to download. Owners/admins can manage workspace transfers; members manage their own files; viewers cannot upload or revoke.
5. Review usage, export workspace activity, or simulate a plan in team settings. Sandbox plan changes collect no payments.

The UI refreshes transfer status every five seconds. Password-protected or excessive archives/documents are blocked by scanner policy. A scan error never releases a file. Malware scanning reduces risk but cannot guarantee a file is safe.

Pilot plan: 100 MB, 100 files, 5 seats. Team sandbox plan: 1 GB, 1,000 files, 25 seats. Each transfer reserves capacity atomically; failed uploads and completed deletion return it. Personal workspaces and up to three team workspaces per owner are supported. Plan sizes are local test entitlements, not validated commercial pricing.

Workspace creation, quota reservation and seat changes enforce their limits atomically. Uploads recheck membership after streaming, and downloads recheck current workspace permissions before releasing bytes. Removing a member revokes existing recipient grants immediately; a later explicit grant can authorize access again. Sandbox downgrades below current usage or seat count are rejected.

```bash
docker compose --env-file /dev/null -f compose.app.yaml logs --tail=100 app worker scanner
docker compose --env-file /dev/null -f compose.app.yaml down
```

`down` preserves named volumes. The historical preview on 3080 is separate; use 3081 for the working application.

## Optional private S3 storage

After initializing the local stack, enable the Garage overlay:

```bash
node scripts/init-s3.cjs
docker compose --env-file .env.s3 -f compose.app.yaml -f compose.s3.yaml up -d --build --wait
```

The generator preserves existing S3 credentials and writes ignored `.env.s3` and `secrets/garage.toml` files. Protect these alongside `.env.local`. Garage has no host ports and stores encrypted objects on a persistent volume. New uploads use S3; existing filesystem transfers remain readable. Use both Compose files for subsequent logs, restart and shutdown commands. This single-node local service has no replica redundancy.

The adapter supports explicit `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` and `S3_PREFIX` configuration, as shown in [.env.example](.env.example). It uses configured credentials rather than ambient AWS profiles. Keep endpoint, bucket, prefix and existing filesystem paths stable while transfer records reference them. Startup fails when a required backend is unavailable or unconfigured.

[The operations guide](docs/OPERATIONS.md#private-s3-storage-and-migration-v040) covers verified ciphertext migration in either direction. Migration preserves source copies until the transfer is deleted, so keep the original filesystem volume accessible during that compatibility period. `bash scripts/backup-local.sh` detects the running stack, pauses writes, creates an encrypted snapshot and resumes services. Restore can target an empty filesystem directory or an empty S3 bucket/prefix, and verifies authenticated file bytes before completion.

## Verification

```bash
npm ci --ignore-scripts
npm run check
npm run check:secrets
npm test
TEST_MONGO_URI=mongodb://127.0.0.1:27017 npm run test:integration
```

The Compose MongoDB service has no host port. To test it using the app image:

```bash
docker compose --env-file /dev/null -f compose.app.yaml run --rm --no-deps --user root \
  -v "$PWD/test:/app/test:ro" -e TEST_MONGO_URI=mongodb://mongo:27017 app npm run test:integration
docker compose --env-file /dev/null -f compose.app.yaml exec -T app node < scripts/smoke.cjs
npx playwright install chromium
npm run test:browser
```

With the S3 overlay running, test real object storage and then run the same live smoke/browser workflows:

```bash
docker compose --env-file .env.s3 -f compose.app.yaml -f compose.s3.yaml run --rm --no-deps --user root \
  -v "$PWD/test:/app/test:ro" -e TEST_MONGO_URI=mongodb://mongo:27017 -e TEST_S3=true app npm run test:integration
docker compose --env-file .env.s3 -f compose.app.yaml -f compose.s3.yaml exec -T app node < scripts/smoke.cjs
npm run test:browser
bash scripts/backup-local.sh
```

Tests create uniquely named disposable databases and remove them afterward. Coverage includes OTP replay/races/expiry/attempts, tenant isolation, current role checks, concurrent workspace limits, quota/plan contention, scanner and SMTP outages, worker replacement/leases, sandbox event idempotency, encryption/key rotation/tampering, deletion retries, restart persistence, encrypted backup restore and corruption rejection. S3 coverage includes multipart upload interruption/cleanup, independent storage clients, bad credentials, verified migration/reversal, destination conflicts, required-backend readiness, and restores to both backends. The S3 suite skips unless `TEST_S3=true` with configured credentials. CI runs both storage modes. The smoke workflow tests real ClamAV with the harmless EICAR fixture. Chromium checks workspace creation, safe filename rendering, viewer access, recipient downloads, audit export and revocation. Browser artifacts are ignored by Git.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health`, `/ready` | Liveness and database/storage readiness |
| POST | `/api/request-otp` | `{email}` → challenge `sessionId` |
| POST | `/api/verify-otp` | `{sessionId, otp}` → session `token` |
| POST | `/api/logout` | Revoke current session |
| GET / POST | `/api/organizations` | List / create workspaces |
| PUT | `/api/organizations/:id/members` | Add/update `{email, role}` |
| DELETE | `/api/organizations/:id/members/:email` | Remove member and recipient grants |
| POST | `/api/upload` | Multipart `file`, `recipient`, `expiryHours` |
| GET | `/api/files` | Recent authorized transfer records |
| GET | `/api/file/:id/download` | Authenticated attachment after scanning |
| DELETE | `/api/file/:id` | Revoke access and queue deletion |
| GET | `/api/usage` | Quota and recent usage records |
| GET | `/api/audit/export` | Admin-only NDJSON activity export, cursor pagination |
| GET | `/api/operations` | Admin-only worker/backlog status |
| POST | `/api/billing/sandbox/events` | Owner-only simulated `{eventId, plan, status}` |

Protected requests require `Authorization: Bearer <token>`. `X-Organization-ID` selects a workspace; omission selects the personal workspace. `X-File-Size` allows exact upload quota reservation and enforces the declared size as a streaming limit; omitting it reserves the maximum file size. A recipient grant permits access across workspaces, while tenant administration never permits access to another organization's files.

Tokens are opaque random secrets stored as hashes and expire after one hour. Browser tokens stay in memory. Codes expire after ten minutes, allow five attempts, and can be consumed once. MongoDB stores shared rate-limit counters. Download usage records represent authorized download attempts, not proof of complete client receipt. SMTP delivery is at-least-once.

## Security and operations

Uploads stream directly into ciphertext storage. Each file has a random AES-256-GCM data key wrapped by a versioned server key. Download plaintext is bounded in memory until authentication completes. The app defaults to 10 MB/file and four concurrent transfers/process. ClamAV may extract plaintext into its memory-backed temporary directory during inspection. Server operators can decrypt files; this is not end-to-end encryption.

Only the app and email inbox have loopback host ports. Local MongoDB is unauthenticated on a private Docker network. Filesystem storage uses one persistent volume; optional Garage storage also runs on one local node. The shared S3 adapter has been tested locally; production provisioning, redundancy, managed KMS, HTTPS/authenticated infrastructure, identity-provider SSO and real payment integration remain external work. During migration, retained filesystem copies still require the original volume. Retain all necessary historical keys for backups. The original CBC prototype is not automatically migrated.

See [operations and recovery](docs/OPERATIONS.md), [delivery status](docs/DELIVERY_STATUS.md) and the [historical audit](ENTERPRISE_AUDIT_AND_PLAN.md). The release plan's customer validation, credential rotation, external security review, production recovery/load tests, commercial evidence and demand-driven scale work remain external gates. Legacy models/middleware/utils and the old Docker deployment are unused by the current app and retained only as historical migration references.
