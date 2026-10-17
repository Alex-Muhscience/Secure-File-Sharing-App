# Secure Transfer — v0.5.0

An encrypted file-sharing application with compact navy, scarlet and white screens, team workspaces, platform administration, usage analytics and configurable billing. Built with Node 24, Express, MongoDB and private filesystem/S3 storage. **This release is for local pilot use.** Production infrastructure, merchant accounts and full-scale validation remain operator work. Secure Transfer is the working name; branding is still open.

## Run locally

Requires Node 24 and Docker Compose. Allow about 2 GB for ClamAV plus application/database memory.

```bash
node scripts/init-local.cjs
docker compose --env-file /dev/null -f compose.app.yaml up -d --build --wait
```

Open **http://localhost:3081**. Sign-in codes and notifications appear in the local inbox at **http://localhost:8025**. Mailpit does not deliver email to external recipients. Keep ignored `.env.local`, its keys, and the named volumes. Initializers preserve existing credentials. `docker compose ... down` preserves volumes; do not remove them to update the app.

1. Verify your email, then select a personal or team workspace.
2. Choose **Send a file**. Separate File → Recipient → Access → Review screens keep the task compact. Back preserves your entries.
3. Select automatic, maximum or no compression. Upload progress reflects accepted chunks; pause and resume by reselecting the same unmodified original file.
4. Copy the recipient link. Files stay quarantined until inspection succeeds. Recipients verify their email to download; the browser handles the file without buffering the entire download in page memory.
5. Workspace owners/admins can open **Analytics**, **Billing** and **Workspace settings**. Platform operators receive a separate **Platform** screen only after explicit server configuration.

Owners/admins manage workspace transfers and members; members manage their own files; viewers cannot upload or revoke. Removing membership also invalidates older recipient grants. Expiry, revocation, current roles and subscription access are checked on the server. Notifications retry after failures; SMTP delivery is at least once.

## What this release includes

- Responsive navigation, search and status filters, accessible dialogs, keyboard focus handling, readable errors and retry states. Fonts and icons are served locally.
- Client analytics for 7/30/90 days, real upload/download totals, measured compression savings, storage quotas, charts and a daily table.
- Client billing with actual subscription state, entitlements, paginated payment history, terms review and provider status. Empty histories stay empty.
- Separate platform Clients/Analytics screens, paginated client search, aggregate analytics, guarded manual subscriptions and separate access suspension with audit reasons. Platform access never grants file-content access.
- Stripe recurring **or prepaid** checkout, M-Pesa prepaid renewals and a configurable crypto adapter. Checkout remains **off** until configured; no prices, currency, administrator identity or merchant credentials are supplied by default.
- Resumable, encrypted chunk uploads; authenticated range downloads; scanning with backpressure; encrypted streaming snapshots; verified migration and key rewrapping.

Local plan entitlements: Pilot 100 MiB / 100 files / 5 seats; Team 1 GiB / 1,000 files / 25 seats; Enterprise 10 TiB / 10,000 files / 500 seats. These are configurable-product entitlements in the source, not commercial prices or proven deployment capacities. Reservations account for original bytes. Sandbox changes collect no money and cannot override paid subscriptions or an operator suspension. A personal owner may create up to three team workspaces.

## Platform administration

No administrator email has been chosen. The allowlist is deliberately empty. After choosing the operator identity, run:

```bash
node scripts/configure-admin.cjs operator@your-domain.example
docker compose --env-file /dev/null -f compose.app.yaml up -d --wait app worker
```

Use your real operator address in place of the example. The command updates only `PLATFORM_ADMIN_EMAILS` in `.env.local`, preserves other settings/keys, and writes with mode 0600. Sign in using that email. `--remove ADDRESS` removes a grant. With S3 enabled, use both Compose files and `.env.s3` as below. Workspace ownership never implicitly grants platform privileges. Pausing a client stops application access; cancel an automatic subscription separately in the provider portal.

## Billing setup

`BILLING_MODE=off` and `BILLING_CATALOG={}` are the defaults. The local stack exposes a clearly labeled entitlement simulator. Real checkout needs explicit prices/currency/access terms, provider credentials and webhook configuration. Supported catalog currencies are KES, USD, EUR and GBP; M-Pesa uses whole Kenyan shillings.

Stripe supports automatic subscriptions and one-off prepaid terms. M-Pesa and crypto support prepaid access. A same-plan prepaid renewal extends the remaining term; changing plans starts a fresh term without proration. Provider verification, idempotent orders and guarded entitlement updates precede access. Callback claims alone cannot mark a payment as settled. The optional BitPay adapter is available for evaluation; no crypto provider/account has been activated.

See [billing configuration and reconciliation](docs/BILLING.md) for the catalog schema, test workflow, callback URLs and operational boundaries. Live payments require merchant onboarding and sandbox acceptance with your accounts. Prices are never inferred from plan names.

## Large files, encryption and compression

**Default acceptance is 10 MiB per file.** The effective limit is the smaller of `MAX_FILE_SIZE` and `SCAN_MAX_FILE_SIZE`. The included ClamAV stack is configured for a 25 MiB stream; changing only the upload limit does not make the scanner capable of terabyte inspection.

The application accepts an explicitly configured target up to **5 TiB** using 8–16 MiB encrypted chunks, persisted offsets/checksums and streaming reads. This is an architectural/configuration ceiling, **not a demonstrated 5 TB production transfer**. Larger inspection requires an operator-provided HTTPS scanner implementing the full-byte contract, provisioned storage/network capacity and representative recovery/load trials. See [large-file configuration and format](docs/LARGE_FILES.md).

Each chunk is optionally compressed with Brotli before AES-256-GCM encryption, using an independent random data key wrapped by the server keyring. A keyed manifest binds the complete ordered file. Each chunk authenticates before its plaintext is released; excessive decompression and incomplete/tampered sequences fail. Snapshots use libsodium XChaCha20-Poly1305 secretstream. Existing GCM files and prior STBK1 snapshots remain readable; the old CBC prototype requires a separate migration.

The [1 GiB synthetic benchmark](docs/benchmarks/2026-10-17-one-gib.json) achieved **74.975% storage reduction**, **180.4 MiB peak process RSS**, and an exact SHA-256 download match. Its input was deliberately 75% repetitive data, and its scanner only counted bytes. It establishes neither a typical compression ratio nor terabyte malware-scanning throughput. Already compressed/encrypted files may shrink little or not at all. Maximum compression is slower and cannot guarantee 75–80% savings or outperform every compressor.

Encryption is **server managed**, not end to end: authorized server operators can decrypt content. Keys currently come from protected environment configuration; managed KMS/HSM, independent security assessment and production controls remain external gates. No “world's strongest” or certification claim is made.

## Optional private S3 storage

```bash
node scripts/init-s3.cjs
docker compose --env-file .env.s3 -f compose.app.yaml -f compose.s3.yaml up -d --build --wait
```

Garage has no host port and keeps ciphertext on a persistent volume. This single-node local service has no replica redundancy. The initializer writes ignored `.env.s3` and `secrets/garage.toml`; protect both. New uploads use S3 and existing filesystem files remain readable. Use both Compose files for later operations. Explicit S3 credentials are used; ambient AWS profiles are not consulted.

[Operations](docs/OPERATIONS.md#private-s3-storage-and-migration-v040) covers migration/reversal, retained source copies, key rotation, backup and restore. `bash scripts/backup-local.sh` detects the stack, pauses writes, creates an encrypted archive and resumes services. Restore requires a new `restore_*` database and an empty object destination. Keep every key needed by retained archives.

## Verify changes

```bash
npm ci --ignore-scripts
npm run check
npm run check:secrets
npm test
TEST_MONGO_URI=mongodb://127.0.0.1:27017 npm run test:integration
npx playwright install chromium
npm run test:ui
BROWSER_STORAGE=filesystem npm run test:browser
```

The Compose database has no host port. With the S3 stack running, test its real MongoDB/Garage services:

```bash
docker compose --env-file .env.s3 -f compose.app.yaml -f compose.s3.yaml run --rm --no-deps --user root \
  -v "$PWD/test:/app/test:ro" -e TEST_MONGO_URI=mongodb://mongo:27017 -e TEST_S3=true app npm run test:integration
docker compose --env-file .env.s3 -f compose.app.yaml -f compose.s3.yaml exec -T app node < scripts/smoke.cjs
BROWSER_STORAGE=s3 npm run test:browser
bash scripts/backup-local.sh s3
```

Tests use isolated disposable databases and prefixes. Coverage includes tenant/platform authorization, quota/contention, current subscription access, duplicate/out-of-order payments, official Stripe SDK requests against a controlled HTTP fixture, resumable upload recovery, range downloads, tampering, scanner/source failures, worker maintenance, old/new snapshots, S3 migration/reversal and key rotation. Provider fixtures do not establish real merchant-account acceptance. Real ClamAV/EICAR, Mailpit and browser workflows run against packaged images in both storage modes. The UI suite checks failure states, race handling, keyboard focus, 200% text, reduced motion and axe accessibility rules. Browser artifacts under `test-results/` are ignored. Chromium is the browser currently exercised; human accessibility and other-browser acceptance remain necessary.

## API

Protected API requests use `Authorization: Bearer <token>` and optional `X-Organization-ID` (otherwise the personal workspace). Workspace selection never overrides authorization.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health`, `/ready`, `/api/config` | Health and safe client configuration |
| POST | `/api/request-otp`, `/api/verify-otp`, `/api/logout` | Email verification and session revocation |
| GET | `/api/me` | Verified identity and explicit platform privilege |
| GET / POST | `/api/organizations` | List/create workspaces |
| PUT / DELETE | `/api/organizations/:id/members[/:email]` | Role/member management |
| GET / POST | `/api/uploads` | Resume list / create encrypted upload |
| GET / DELETE | `/api/uploads/:id` | Offset/status / discard partial upload |
| PUT | `/api/uploads/:id/chunks` | Raw chunk, `Upload-Offset`, `X-Chunk-SHA256` |
| POST | `/api/uploads/:id/complete` | Verify ordered manifest, finalize and quarantine |
| POST | `/api/upload` | Bounded legacy multipart upload |
| GET | `/api/files` | Authorized recent transfers, optional `transfer` UUID lookup |
| GET | `/api/file/:id/download` | Bearer-authenticated attachment; single byte ranges |
| POST | `/api/file/:id/download-ticket` | One-use native-download handoff |
| GET | `/api/download/:ticketOrFileId` | Handoff or scoped browser attachment/resume |
| DELETE | `/api/file/:id` | Revoke immediately and queue physical deletion |
| GET | `/api/usage`, `/api/analytics`, `/api/billing/overview` | Tenant usage, analytics and billing |
| POST | `/api/billing/checkout`, `/api/billing/portal` | Owner-only configured checkout/provider portal |
| GET | `/api/billing/orders/:id` | Owner-only payment status |
| POST | `/api/payments/stripe/webhook`, `/api/payments/{mpesa,crypto}/callback` | Signed Stripe events / untrusted verification hints |
| GET | `/api/platform/analytics`, `/api/platform/clients[/:id]` | Explicit operator analytics and client management |
| PUT | `/api/platform/clients/:id/subscription`, `/api/platform/clients/:id/access` | Guarded manual plan or application-access change |
| GET | `/api/audit/export`, `/api/operations` | Workspace administrator audit and worker status |
| POST | `/api/billing/sandbox/events` | Owner-only local entitlement simulation |

OTP codes expire after ten minutes, allow five attempts and can be consumed once. App tokens are hashed, expire after one hour and stay in browser memory. A native download uses a one-use 60-second handoff, then a file-scoped HttpOnly/SameSite cookie that lasts until transfer expiry so a large download can resume beyond app sign-in expiry. It cannot authenticate other APIs. Explicit logout revokes associated grants; file expiry, revocation, membership and billing are rechecked during streaming. Download counts/bytes describe authorized HTTP requests, including ranges/retries, not confirmed receipt.

## Release boundaries

Local MongoDB is unauthenticated on a private network. Filesystem and Garage storage are local single-instance infrastructure. Production requires authenticated/TLS services, managed keys/storage, external email, chosen operator identity, merchant onboarding, backup/rollback/load drills, alerts/support ownership and independent security review. SSO/SCIM, regional redundancy and immutable external audit retention are not implemented. Historical exposed credentials still require provider rotation; Git history has not been rewritten. Legacy models/middleware/utils and the old deployment are historical references, unused by the current runtime.

See [delivery status](docs/DELIVERY_STATUS.md), [operations](docs/OPERATIONS.md), [interface specification](design.md) and the [historical audit](ENTERPRISE_AUDIT_AND_PLAN.md). Changes are reviewed through [PR #6](https://github.com/Alex-Muhscience/Secure-File-Sharing-App/pull/6); merging to main requires owner approval.
