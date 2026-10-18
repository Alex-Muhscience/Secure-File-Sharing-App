# Secure File Transfer — development audit and delivery plan

> **Archived baseline — 2026-10-14, before the current application was built.** Reconciled on 2026-10-18: v0.6.0 is a working local pilot merged through PR #8. Missing-service, tracked-dependency, vulnerability-count and preview-only findings below describe the original checkout, not current `main`. They are retained as historical evidence, not present-tense status or current operating instructions.
>
> Start with [README](README.md), use [delivery status](docs/DELIVERY_STATUS.md) for what is built/remaining, and [implementation](docs/IMPLEMENTATION.md) for current code/history. Production acceptance is still outstanding, but it must be assessed from current evidence rather than this baseline.

Audit date: 2026-10-14. Repository: `Secure-File-Sharing-App`. Baseline commit: `271fbd8`.

## Historical executive decision (2026-10-14)

**This checkout is an incomplete prototype, not a deployable secure-transfer product.** It contains a browser interface, Express bootstrap, authentication middleware, four Mongoose models, an older encryption utility, and deployment templates. The configuration, API routes, and core services referenced by the bootstrap are absent. No working transfer, enterprise security, performance, compliance, or revenue claim can be established from this code.

The immediate objective should be a trustworthy, testable transfer workflow for a narrow customer segment. Enterprise expansion comes after functional restoration and paid customer validation. A million-dollar business is a commercial objective, not an outcome guaranteed by adding features.

**Historical local deployment outcome:** an isolated Docker interface preview is available at `http://localhost:3080`. It explicitly disables transfers and email verification. The real backend remains blocked by missing source code. See the runbook below. Do not treat preview health as application readiness.

## Scope and evidence quality

Reviewed all first-party JavaScript, frontend HTML, package manifests, Git tracking, Docker/Compose/Kubernetes files, GitHub workflows, and README claims. No customer systems or external accounts were accessed. Secret values were not copied into this report. Findings distinguish code inspection from successful runtime checks; missing services prevent validation of route enforcement and complete workflows.

| Verification | Observed result |
| --- | --- |
| `node app.js` against supplied dependencies | Fails resolving `side-channel-list` inside Express dependencies. |
| Resolve relative imports in application and middleware | Seven missing imports: `./config`, `./utils/logger`, `./services/StorageService`, `./services/FileService`, `./routes/api`, `../services/AuthService`, `../services/ValidationService`. |
| Load models for behavior checks | Blocked by missing `mongoose/lib/connectionstate` in supplied dependencies. Model findings below are static analysis, not executed exploit tests. |
| `npm test` | Exits 1: placeholder “no test specified.” No first-party test suite present. |
| `npm run lint` | Exits 127: ESLint executable unavailable; no first-party ESLint configuration found. |
| Git tracking | `.env` and 2,293 paths under `node_modules` tracked despite ignore rules. |
| `npm audit --omit=dev --json` | Registry reports 94 vulnerable package entries: 6 critical, 44 high, 27 moderate, 17 low. Snapshot in `docs/audit/npm-audit-2026-10-14.json`. These are dependency findings, not proof of 94 exploitable application flaws. |
| Docker preview build/start | Successful with Node 24 Alpine; container healthy. No npm packages or repository credentials included in preview build. |
| Preview HTTP checks | Root/CSS/health succeed; page labels preview and disables controls; API/readiness return 503; `.env`, app source, package manifest and script URLs return 404. |

The original full application image was not certified or started: rebuilding dependencies cannot restore absent source modules. No penetration test, browser accessibility audit, load test, full image scan, or backup restore test has been completed.

## Prioritized findings

P0 = blocks any real-data release. P1 = required before paid multi-customer operation. P2 = maturity work after the pilot is reliable. Severity describes the impact if the affected code is used; unreachable code is not claimed to be remotely exploitable today.

| ID / priority | Evidence and gap | Impact / required correction |
| --- | --- | --- |
| F01 / P0 | `app.js` and `middleware/auth.js` import seven absent modules listed above. README describes additional absent services/contracts/configuration. | No application startup or API implementation. Recover intended source from project history/backups, or implement contracts deliberately; do not replace missing security services with success stubs. |
| F02 / P0 | `.env` is tracked; `Deployment.yaml` includes fixed base64 JWT/encryption secret values. Original Dockerfile copies the whole checkout without a pre-existing `.dockerignore`. | Treat any real committed credentials as exposed. Inventory and rotate/revoke provider credentials and signing keys; migrate encrypted data before retiring data keys. Then remove tracked secrets and review history exposure. New `.dockerignore` prevents future build-context inclusion but does not remove history or rotate credentials. |
| F03 / P0 | `utils.js` uses AES-256-CBC without an authentication tag/MAC; reads `SECRET_KEY`, while Compose uses `ENCRYPTION_KEY`. | Encryption integrity and configuration mismatch. Replace with authenticated encryption and versioned key metadata; validate keys on startup. Prefer per-file data keys wrapped by a managed key service for production. Never promise that operators cannot decrypt server-encrypted data. |
| F04 / P0 | `utils.js` returns before piped streams finish, has no awaited pipeline/error handling, writes decrypted temporary files, and uses timestamp-derived paths. | Partial files, unhandled errors, plaintext retention, and collisions are possible. Await pipelines; use random object identifiers, exclusive creation, bounded streaming, cancellation cleanup, and authenticated decryption before releasing plaintext. |
| F05 / P0 | `models/Session.js`: OTP generated with `Math.random`, stored as a code string; `isOTPValid` does not reject already verified codes. Attempts/verification mutate an instance without atomic persistence. | Predictability, replay and concurrency concerns. Use cryptographic randomness, keyed OTP digest, short purpose-bound challenges, atomic consume/attempt updates, resend invalidation and distributed email/IP limits. Separate OTP expiry from login-session lifetime. |
| F06 / P0 | Routes are absent; `FileMetadata` supports email/user ownership but has no organization identity or recipient grant model. | Authorization cannot be verified. Every file action must derive identity from authenticated context, enforce owner/recipient grants and tenant scope, and ignore client-supplied email as authority. Add cross-user/cross-tenant negative tests before sharing real data. |
| F07 / P0 | `package-lock.json` advisory results above; package.json puts blockchain/testing libraries into production dependencies. Supplied tracked dependencies are incomplete. | Large, unverifiable supply chain. Remove unnecessary packages, regenerate dependencies on a supported runtime, triage advisory reachability, and check licenses. Do not blindly use `npm audit fix --force`; it can introduce breaking or unsuitable versions. |
| F08 / P0 | `public/script.js` interpolates `file.name` into `innerHTML`; original CSP allows inline script. | A specially named locally selected file can create executable markup. Render filename/type through text nodes and remove inline-script allowance. Preview avoids this path by not loading that script. Original application remains unfixed. |
| F09 / P1 | `FileMetadata` has TTL deletion on `expiresAt`, while `app.js` schedules missing `FileService.cleanupExpiredFiles`. | Metadata can disappear before object cleanup, leaving orphaned encrypted data. Use a durable deletion queue/tombstone and retryable worker; retain object identity until deletion is confirmed. TTL must not be the object-deletion mechanism. |
| F10 / P1 | Session TTL uses OTP expiration even though JWT defaults to a longer duration. `verifyOTP` permits reuse until expiry/attempt cap. | OTP lifetime and authenticated session lifetime conflict. Define independent challenge and session records, revocation, absolute/idle expiry, and replay behavior. |
| F11 / P1 | `FileMetadata.fileHash` globally unique; `incrementDownloadCount` uses read/modify/save; required `sanitizedName` is populated only in a pre-save hook. | Identical uploads across customers conflict; concurrent download caps can race; validation may reject a name before pre-save sanitization runs. Scope deduplication deliberately, enforce caps atomically, sanitize before validation, and replace ambiguous `length` schema options with explicit validators. |
| F12 / P1 | `middleware/auth.js` writes `AUTH_FAILURE`, absent from `AuditLog` enum. Middleware places IP under `details`, while log helper reads top-level `ipAddress`. Logs have a fixed 90-day TTL. | Security events can fail validation or lose structured attribution. Standardize event schemas, redact sensitive data, define retention per customer policy, and export to access-controlled append-only storage. Handle audit failures explicitly. |
| F13 / P1 | Sensitive rate limiter uses process-local Map, scans it on requests, and continues when errors occur. JWT verification has no explicit issuer/audience/algorithm policy. | Replica bypass, memory/CPU pressure, and insufficient token constraints. Use shared bounded counters; define failure policy; bind tokens to validated session identity and configured issuer/audience/algorithm. |
| F14 / P1 | `/health` reports 200 when DB disconnected; storage errors do not change overall health. Server starts without awaiting connection. Shutdown closes DB then exits without draining HTTP. | Load balancers can send traffic to an unusable process and interrupt active transfers. Separate liveness/readiness, await critical dependencies, return 503 for readiness failures, drain HTTP/workers and stop timers on shutdown. |
| F15 / P0 | Original Compose references missing `nginx.conf`, SSL directory and Mongo initialization assets; exposes unauthenticated Mongo port and app on all host interfaces. | Original deployment is incomplete and unsafe as a default. New separate preview binds only loopback. Restore a real local app stack with private authenticated DB, mail capture, persistent storage, dependency readiness and documented secrets. |
| F16 / P1 | Original Dockerfile uses Node 18; Kubernetes has three replicas with shared ReadWriteOnce claims and local cleanup timers. | Unsupported runtime and deployment/storage assumptions. Select supported runtime; test volume topology, move files to object storage and cleanup to coordinated workers; pin release images and validate rollout/rollback. |
| F17 / P0 | `npm test` intentionally fails; CI invokes it; no real tests, build verification or meaningful coverage evidence. | No dependable release gate. Add authorization, OTP, encryption/tamper, upload abuse, deletion and end-to-end suites; enforce clean install and image smoke tests in CI. |
| F18 / P1 | Frontend requests OTP, uploads and immediately downloads the same user's file. No recipient invitation, sharing URL, file list, revoke UI, admin view or account recovery. | Current UX is a round-trip demonstration, not a usable transfer workflow. Build sender/recipient lifecycle, explicit status/progress, cancellation/retry and accessible feedback. |
| F19 / P1 | No organizations/RBAC, billing, metering, plan limits, admin provisioning, SSO/SCIM, support workflow or customer-facing API lifecycle found. | Enterprise procurement and repeatable revenue are unsupported. Implement essentials in phases below; avoid selling unimplemented controls. |
| F20 / P1 | README claims production readiness, inability to read customer files, Web3 capability, performance and completed tests; missing referenced docs and LICENSE file. | Material trust and procurement risk. Rewrite around demonstrated behavior; verify ownership/licensing; publish measured limits and an accurate security model. Package metadata alone does not establish licensing for the entire distribution. |

## Recommended architecture and product boundaries

Retain a modular Node/Express application initially; introducing microservices would not repair the missing product. Keep MongoDB only if the team can implement atomic transitions, indexes, migrations and recovery reliably. Use clear modules for identity, organizations, transfers, recipients, storage, notifications, billing and audit.

Proposed flow: authenticated sender → tenant-scoped transfer record → quarantined upload → validation/malware scan → encrypted object storage → recipient grant/notification → verified recipient → authorized download → audited expiry/revocation/deletion. The database stores metadata and access policy; object storage stores bytes; durable workers handle scanning, notification and deletion. Production keys belong in a dedicated key service. Provide local equivalents with isolated development credentials and email capture.

Define the trust model before promising end-to-end encryption. Server-side malware scanning and server-managed recovery differ from a client-only encryption design. Select one coherent initial design and disclose which actors can decrypt. Defer blockchain/IPFS until a paying customer's requirement justifies their privacy, deletion and operational costs.

Missing upload controls include enforceable size/concurrency/storage quotas, content checks beyond MIME declarations, safe filenames, archive-bomb protections if archives are inspected, quarantine, malware policy, interrupted upload cleanup and download headers that prevent inline execution. These follow [OWASP upload guidance](https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html). Authenticated encryption and lifecycle controls should follow [OWASP cryptographic storage](https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html) and [key management guidance](https://cheatsheetseries.owasp.org/cheatsheets/Key_Management_Cheat_Sheet.html). Node 18 is end-of-life; verify the supported runtime against the [official Node release schedule](https://github.com/nodejs/Release).

## Delivery plan with acceptance gates

Estimates below are planning ranges, not commitments: assume two experienced engineers, part-time QA/product/design and security review. Adjust after source recovery and customer discovery. Phases overlap only when their dependencies permit.

| Phase / estimate | Owner | Deliverables | Exit evidence |
| --- | --- | --- | --- |
| 0: recovery and containment, 3–5 working days | Technical lead + account owners | Recover missing source; map API contracts; rotate exposed real credentials; separate secrets; replace README status; remove tracked dependency artifacts through a reviewed change; select supported Node/dependency set. | Clean checkout identifies all required modules; no known live secret in source; clean installation reproducible; architecture and threat model agreed. |
| 1: functional foundation, 2–4 weeks | Backend + frontend engineers | Configuration validation; OTP/session APIs; authenticated streaming upload/download; authenticated encryption; mail capture; file lifecycle; usable local Docker backend stack; meaningful CI. | Automated sender flow preserves bytes; wrong OTP, replay, unauthorized user, corrupt ciphertext and missing dependencies fail safely; restart preserves data; full stack starts from documented commands. |
| 2: private multi-customer pilot, 4–6 weeks | Engineering + QA + security | Organizations, membership roles, recipient grants, expiry/revoke, file management UI, quotas, scan/quarantine, worker retries, tenant audit export, billing sandbox and usage ledger. | Two tenants cannot access each other's records/objects; expired/revoked access denied; deletion completes after worker outage; usage/billing webhooks are idempotent; 3–5 design partners finish representative tasks. |
| 3: enterprise release, 6–10 weeks | Platform + security + product | SSO and enterprise provisioning as contracted; production key management; backups/restore; monitoring/on-call; customer policy controls; incident/support processes; procurement documentation; external security assessment. | Independent security findings resolved or explicitly accepted; restore and rollback rehearsed; agreed load/SLO tests pass; paid pilots show repeat usage and support readiness. |
| 4: scale, continuous | Product + engineering + sales | Resumable uploads, integrations/API keys/webhooks, region options, advanced retention, channel sales and cost optimization driven by demand. | Expansion/retention and unit economics justify each feature; capacity tested before increasing customer limits. |

First implementation backlog, in order: F02 secret inventory; F01 source recovery; F07 dependency cleanup; F03–F06 secure transfer core; F17 tests; F09 deletion; F14 readiness; F18 usable transfer workflow; then tenant and billing foundations. Do not spend the first sprint on Web3, visual redesign or Kubernetes expansion.

## Enterprise release criteria

- Security: threat model reviewed; object-level authorization tested on every API; OTP replay and parallel attempt tests; ciphertext tamper rejection; key rotation/recovery tested; upload abuse controls exercised; no unresolved exploitable critical/high findings without an explicit accountable exception.
- Reliability: proposed initial service target 99.9% monthly availability, recovery point ≤24 hours and recovery time ≤4 hours. These are design targets requiring customer agreement and drills, not existing guarantees. Measure p95 metadata API latency and transfer throughput under a declared file-size/concurrency profile before advertising capacity.
- Data lifecycle: revoke/expire denies access immediately according to defined policy; deletion retries survive crashes; orphan reconciliation works; backup retention and customer deletion commitments are documented together.
- Operations: independent readiness, structured redacted logs, queue/error/storage metrics, actionable alerts, runbooks, rollback rehearsal, and an owned on-call/support rota.
- Commercial: working onboarding, entitlement enforcement, usage accounting, idempotent billing events, invoices/refunds process, cancellation/export and a clear support offer.
- Governance: identify actual customer jurisdictions and data classes; obtain appropriate privacy/contract advice; document subprocessors, incident response, access reviews and retention. Do not claim a certification or legal compliance from implementation alone.

## Commercial plan toward million-dollar annual revenue

Treat **annual recurring revenue (ARR)** as the planning metric, not profit or cash received. No market-size research, customer interviews, willingness-to-pay evidence or competitive advantage is established by this audit.

Working hypothesis: small and mid-sized professional-service teams exchanging sensitive client documents may value recipient verification, branded requests, enforceable expiry and exportable activity history. Validate this with interviews before committing to a sector. General file storage is a broad proposition; pick one repeatable customer workflow.

| Illustrative scenario | Assumed recurring price | Customers needed | Annualized revenue |
| --- | --- | --- | --- |
| Team-led | $250/month per organization | 334 | $1,002,000 |
| Mid-market | $1,000/month per organization | 84 | $1,008,000 |
| Enterprise contracts | $20,000/year per organization | 50 | $1,000,000 |

These are arithmetic scenarios, not price recommendations or forecasts. Validate packaging through 15–20 buyer interviews, then 3–5 design partners and paid pilots. Ask about existing workflow, frequency, current spend, purchase authority, integration needs and the measurable cost of failure. Charge for validated operational value; enterprise procurement may require security evidence before it accepts a pilot.

Model contribution margin per organization: recurring revenue minus storage, egress, scanning, email, compute/database, payment fees and allocated support cost. Track peak concurrent transfers and abusive/free usage; quota and metering design must precede unlimited plans. Proposed planning goals: gross margin ≥75%, CAC payback <12 months and net revenue retention >100%, subject to measured sales/support costs. At $1 million ARR and 75% gross margin, $750,000 remains before sales, engineering and other operating costs; ARR is not profit.

First 90 days: complete recovery and security foundation while interviewing buyers; pilot one workflow; measure activation (first successful recipient download), repeat weekly use, paid conversion, churn reasons, support minutes and cost per transferred GB. Continue enterprise investment only when customers demonstrate repeat use and willingness to pay. Review competitor offerings and procurement requirements against the chosen segment before final pricing.

## Docker local deployment runbook

The original `docker-compose.yml` and Dockerfile remain as audited legacy artifacts. **Use the separate `compose.local.yaml` for the verified preview.** It runs a small built-in Node HTTP server, serves an allowlist of UI assets, excludes repository secrets/dependencies, runs non-root with a read-only filesystem and dropped capabilities, and binds to loopback. It loads no `.env` and sends no email. The interface's unsupported security promise is removed in the served preview only.

From the repository root:

```bash
docker compose --env-file /dev/null -f compose.local.yaml up -d --build --wait
docker compose --env-file /dev/null -f compose.local.yaml ps
curl http://localhost:3080/health
curl -i http://localhost:3080/ready
docker compose --env-file /dev/null -f compose.local.yaml logs --tail=100 preview
```

Expected: browser preview at `http://localhost:3080`; `/health` returns 200 with `mode: interface-preview` and backend unavailable; `/ready` and `/api/*` return 503. The health check only asserts preview serving. File selection and submit controls are disabled. This does not constitute a successful application deployment or end-to-end transfer test.

If port 3080 is occupied, prefix the start command with `LOCAL_PREVIEW_PORT=3081`. Rebuild after asset/server edits. Stop with:

```bash
docker compose --env-file /dev/null -f compose.local.yaml down
```

An optional isolated MongoDB service is defined for backend restoration; it is not required by the preview and is not started by default:

```bash
docker compose --env-file /dev/null -f compose.local.yaml --profile backend-dev up -d --wait
docker compose --env-file /dev/null -f compose.local.yaml exec mongo mongosh --quiet --eval 'db.adminCommand("ping")'
docker compose --env-file /dev/null -f compose.local.yaml --profile backend-dev down
```

This development-only DB has no host port, uses an internal network and retains its named volume. It is not production authenticated storage. A future backend must explicitly join that network and implement configuration/authentication. Avoid `down -v` unless intentionally discarding development data. Optional DB startup was not part of the executed preview verification.

Replacing the preview with the actual application requires Phase 1 completion: source restoration, clean dependencies, validated secrets, database readiness, local email capture and a tested encryption/storage flow. No placeholder response should be counted as implementation of those services.

## Changes made during this audit

Added this report, advisory snapshot, `.dockerignore`, `compose.local.yaml`, and `docker/local/` preview assets. Built and started `secure-transfer-local-preview-1` and ran HTTP smoke assertions. Original application code, dependency lockfile, credentials, and legacy deployment templates were not repaired or rotated. No existing project containers were stopped, no Git history was rewritten, and no remote deployment or paid service was created.
