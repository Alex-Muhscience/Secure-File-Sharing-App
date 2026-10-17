# Secure Transfer — v0.6.0

An encrypted file-sharing and lossless compression application with compact navy, scarlet and white screens, file-category/industry guidance, team workspaces, platform administration, usage analytics and configurable billing. Built with Node 24, Express, MongoDB and private filesystem/S3 storage. **This release is for local pilot use.** Production infrastructure, merchant accounts and full-scale validation remain operator work. Secure Transfer is the working name; branding is still open.

## Run locally

Requires Node **24.19 or later in the 24.x line** and Docker Compose. Strict compressed-stream checks use the newer Node 24 APIs; the tested runtime is 24.21. Allow about 2 GB for ClamAV plus application/database memory.

```bash
node scripts/init-local.cjs
docker compose --env-file /dev/null -f compose.app.yaml up -d --build --wait
```

Open **http://localhost:3081**. This development workspace also uses **http://secure-transfer.localhost:3081** with `APP_URL` set to that origin. Sign-in codes and notifications appear in the local inbox at **http://localhost:8025**. Mailpit does not deliver email to external recipients. Keep ignored `.env.local`, its keys, and the named volumes. Initializers preserve existing credentials. `docker compose ... down` preserves volumes; do not remove them to update the app.

1. Verify your email, then select a personal or team workspace.
2. Choose **Compress a file**, then **Compress and download**, **Compress and send**, or **Restore an archive**. File type → File → Options → Review screens keep the task compact. Back preserves your entries. The original **Send a file** flow remains available.
3. Select **Fast transfer**, **Smallest archive**, the experimental **custom-engine comparison**, or original storage. Eligible chunks are compressed in a browser worker before upload; pause/resume keeps logical offsets and exact original checksums. Reselect the same unmodified original to resume.
4. After inspection, download a `.stc` or standard `.gz` archive, download the exact original, or copy the recipient link. Private compression/restore jobs require no recipient and send no email. Recipients verify their email before downloading. Native downloads avoid whole-file page-memory buffering.
5. Workspace owners/admins can open **Analytics**, **Billing** and **Workspace settings**. Platform operators receive a separate **Platform** screen only after explicit server configuration.

Owners/admins manage workspace transfers and members; members manage their own files; viewers cannot upload or revoke. Removing membership also invalidates older recipient grants. Expiry, revocation, current roles and subscription access are checked on the server. Notifications retry after failures; SMTP delivery is at least once.

## What this release includes

- Responsive navigation, search and status filters, accessible dialogs, keyboard focus handling, readable errors and retry states. Fonts and icons are served locally.
- Client analytics for 7/30/90 days, real upload/download totals, measured compression savings, storage quotas, charts and a daily table.
- Client billing with actual subscription state, entitlements, paginated payment history, terms review and provider status. Empty histories stay empty.
- Separate platform Clients/Analytics screens, paginated client search, aggregate analytics, guarded manual subscriptions and separate access suspension with audit reasons. Platform access never grants file-content access.
- Stripe recurring **or prepaid** checkout, M-Pesa prepaid renewals and a configurable crypto adapter. Checkout remains **off** until configured; no prices, currency, administrator identity or merchant credentials are supplied by default.
- Resumable, encrypted chunk uploads; authenticated range downloads; scanning with backpressure; encrypted streaming snapshots; verified migration and key rewrapping.
- Six file categories with business, finance/legal, healthcare/research, engineering, creative and education guidance. Industry choices do not imply regulatory certification or change the original format.
- A real custom STP1 predictor/bit-packing codec, adaptive Brotli/Zstandard comparisons, gzip interoperability and versioned STC1 archives with exact offline/in-app restore. Existing files remain readable.
- Measured archive targets, separate original/archived download analytics and observed upload payload accounting. Storage savings are never presented as network savings or guaranteed archive ratios.

Local plan entitlements: Pilot 100 MiB / 100 files / 5 seats; Team 1 GiB / 1,000 files / 25 seats; Enterprise 10 TiB / 10,000 files / 500 seats. These are configurable-product entitlements in the source, not commercial prices or proven deployment capacities. Reservations account for original bytes. Sandbox changes collect no money and cannot override paid subscriptions or an operator suspension. A personal owner may create up to three team workspaces.

## Platform administration

This development workspace explicitly enables **`admin@secure-transfer.localhost`**. Open **http://secure-transfer.localhost:3081**, sign in with that address, and retrieve its one-time code from **http://localhost:8025**. The **Platform** navigation item opens client management and platform analytics. There is no shared administrator password. The `.localhost` name is for local development; no public domain or external mailbox has been registered. Chromium was verified with this origin; use `http://localhost:3081` if your resolver does not resolve the alias.

New installations still have an empty allowlist by default. To reproduce this local operator grant, run:

```bash
node scripts/configure-admin.cjs admin@secure-transfer.localhost
docker compose --env-file /dev/null -f compose.app.yaml up -d --wait app worker
```

For a different operator identity, run:

```bash
node scripts/configure-admin.cjs operator@your-domain.example
docker compose --env-file /dev/null -f compose.app.yaml up -d --wait app worker
```

Use your operator address in place of the example. The command updates only `PLATFORM_ADMIN_EMAILS` in `.env.local`, preserves other settings/keys, and writes with mode 0600. Sign in using that email. `ADDRESS --remove` removes a grant. With S3 enabled, use both Compose files and `.env.s3` as below. Local `APP_URL=http://secure-transfer.localhost:3081` and `EMAIL_FROM=Secure Transfer <admin@secure-transfer.localhost>` are optional `.env.local` settings for links and local mail. Granting one exact address never grants other addresses at that domain. Workspace ownership never implicitly grants platform privileges. Pausing a client stops application access; cancel an automatic subscription separately in the provider portal.

## Billing setup

`BILLING_MODE=off` and `BILLING_CATALOG={}` are the defaults. The local stack exposes a clearly labeled entitlement simulator. Real checkout needs explicit prices/currency/access terms, provider credentials and webhook configuration. Supported catalog currencies are KES, USD, EUR and GBP; M-Pesa uses whole Kenyan shillings.

Stripe supports automatic subscriptions and one-off prepaid terms. M-Pesa and crypto support prepaid access. A same-plan prepaid renewal extends the remaining term; changing plans starts a fresh term without proration. Provider verification, idempotent orders and guarded entitlement updates precede access. Callback claims alone cannot mark a payment as settled. The optional BitPay adapter is available for evaluation; no crypto provider/account has been activated.

See [billing configuration and reconciliation](docs/BILLING.md) for the catalog schema, test workflow, callback URLs and operational boundaries. Live payments require merchant onboarding and sandbox acceptance with your accounts. Prices are never inferred from plan names.

## Large files, encryption and compression

**Default acceptance is 10 MiB per file.** The effective limit is the smaller of `MAX_FILE_SIZE` and `SCAN_MAX_FILE_SIZE`. The included ClamAV stack is configured for a 25 MiB stream; changing only the upload limit does not make the scanner capable of terabyte inspection.

The application accepts an explicitly configured target up to **5 TiB** using 8–16 MiB encrypted chunks, persisted offsets/checksums and streaming reads. This is an architectural/configuration ceiling, **not a demonstrated 5 TB production transfer**. Larger inspection requires an operator-provided HTTPS scanner implementing the full-byte contract, provisioned storage/network capacity and representative recovery/load trials. See [large-file configuration and format](docs/LARGE_FILES.md).

Each chunk is optionally compressed with Brotli, Zstandard or the custom STP1 codec before AES-256-GCM encryption, using an independent random data key wrapped by the server keyring. A keyed manifest binds the complete ordered file. Each chunk authenticates before its plaintext is released; excessive decompression and incomplete/tampered sequences fail. Zstandard decoder windows are capped at 16 MiB. Snapshots use libsodium XChaCha20-Poly1305 secretstream. Existing GCM files and prior STBK1 snapshots remain readable; the old CBC prototype requires a separate migration.

The target is **75% archive reduction**: a 1 GB original produces an archive at most 250 MB, including every header/checksum. Results are reported per file as met/not met/not measured. The [codec comparison](docs/benchmarks/2026-10-17-codec-comparison.json) includes all candidates and losses. Our custom STP1 achieved **86.96%** reduction on a deliberately correlated synthetic probe, beating the tested Brotli/Zstandard/gzip settings there; established codecs won the general fixtures. This is specialized evidence, not a claim of universal superiority. A frozen synthetic corpus is not a representative customer/industry benchmark.

The earlier [1 GiB synthetic benchmark](docs/benchmarks/2026-10-17-one-gib.json) achieved 74.975% **storage** reduction and a SHA-256 match on deliberately repetitive input with a counting-only scanner. It does not establish typical archive ratios or terabyte inspection throughput. Already compressed/encrypted files can shrink little or grow with archive overhead. A universal 75–80% lossless guarantee is impossible.

Encryption is **server managed**, not end to end: authorized server operators can decrypt content. Keys currently come from protected environment configuration; managed KMS/HSM, independent security assessment and production controls remain external gates. No “world's strongest” or certification claim is made.

## Compressed downloads and restore

`.stc` is our documented single-file container for bounded, explicit codecs and complete SHA-256/finality verification. Use **Restore an archive** to reconstruct and inspect its original. The service reserves space for both the input archive and the restored original; canceling/failing work releases reservations through cleanup. Standard `.gz` exports open in normal gzip tools. These downloaded archives are **not encrypted**; encryption protects stored content.

Offline restore requires the same Node runtime:

```bash
node scripts/stc.cjs restore downloaded.stc restored-original
# Explicit larger output budget, for example 1 GiB:
node scripts/stc.cjs restore downloaded.stc restored-original --max-bytes 1073741824
```

The CLI defaults to a 10 MiB output cap, verifies the whole archive before publishing its output, and never overwrites an existing destination. The explicit cap can be raised up to 5 TiB; that does not prove infrastructure capacity. Existing original downloads retain byte-range resume. Generated archive exports require a fresh request after interruption and do not advertise ranges. Each representation has a separate native download grant, with current membership, subscription, expiry and revocation enforced.

See [format, codec settings and reproducible measurements](docs/COMPRESSION.md). Compression can save network time on constrained links and add CPU time on fast links; Fast transfer and Smallest archive serve different goals. HTTP fixture results exclude TCP/TLS/API-metadata overhead and browser CPU. The existing quick-send defaults remain available while performance gates and representative customer validation are evaluated.

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
| GET | `/api/file/:id/export/{stc,gzip}` | Guarded streaming compressed archive; no byte ranges |
| GET | `/api/file/:id/compression` | Authorized job status, codec counts and measured export sizes |
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

See [delivery status](docs/DELIVERY_STATUS.md), [operations](docs/OPERATIONS.md), [interface specification](design.md) and the [historical audit](ENTERPRISE_AUDIT_AND_PLAN.md). The enterprise foundation landed through [PR #6](https://github.com/Alex-Muhscience/Secure-File-Sharing-App/pull/6). Final review corrections landed through [PR #7](https://github.com/Alex-Muhscience/Secure-File-Sharing-App/pull/7) after owner approval.

The [industry compression design](docs/superpowers/specs/2026-10-17-industry-compression-design.md) and [implementation plan](docs/superpowers/plans/2026-10-17-industry-compression.md) track v0.6.0 through [PR #8](https://github.com/Alex-Muhscience/Secure-File-Sharing-App/pull/8). That PR requires a separate owner merge decision. Compression ratios and speed remain measured, input-dependent results; actual 1–5 TB operation and production acceptance remain unvalidated.

Final v0.6.0 [per-file ratios, WAN/LAN timing ranges, concurrent/resumed results and default decision](docs/benchmarks/2026-10-18-summary.md): 5/8 nonempty synthetic fixtures meet the 75% target using the best tested setting. Custom STP1 meets it on the specialized probe, not the general set. LAN/tiny-file regressions keep legacy defaults in place.
