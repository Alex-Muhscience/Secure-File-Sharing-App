# Enterprise Workspace Implementation Plan

> Execution: continue natively in this session under the user's existing instruction to build through completion. Use the executing-plans workflow task by task. Preserve the draft PR workflow and ask before merging to main.

**Goal:** Deliver a compact navy/scarlet/white client experience, platform administration, tenant analytics/billing, and verified streaming compression/encryption for large files.

**Architecture:** Keep Express, MongoDB and the filesystem/S3 boundary. Separate platform authorization from workspace roles. Derive dashboards from persisted usage and subscription records. Use established authenticated encryption and streaming compression primitives; retain compatibility with current encrypted objects and snapshots.

**Tech Stack:** Node 24, Express, MongoDB, native web controls, Playwright/axe, private S3/Garage, ClamAV. Use independently keyed AES-256-GCM encrypted parts with an authenticated ordered manifest, Brotli compression, and libsodium secretstream for framed backup encryption.

**Spec:** `design.md`, plus the user's 2026-10-17 requirement for individual step screens, platform client/subscription/analytics administration, client usage/billing dashboards, and large-file protection/compression.

## Global constraints

- Navy blue, scarlet red and white; no fabricated customer data, pricing, payment receipts or security claims.
- Default to the existing local pilot infrastructure until external accounts/credentials and deployment are supplied.
- Do not grant platform privileges to the first sign-up or to workspace administrators implicitly.
- Existing AES-256-GCM objects and keys remain readable. Compression precedes encryption and decompression must have an authenticated size bound.
- Do not call any encryption/compression scheme the world's highest or promise reduction of already compressed files.
- Keep authentication tokens in memory; preserve CSP and tenant isolation. No unsafe HTML rendering.
- User's uncommitted `codex-skills/` and `skills-lock.json` remain untouched.
- Commit/push only on the feature branch, no assistant attribution, and ask before merging to main.

## Confirmed scope and configuration still pending

The user selected Stripe, M-Pesa, and configurable crypto payments, with no crypto provider preference. The target is 1–5 TB per file, with the greatest practical lossless compression; 75–80% is a desired result for suitable inputs, never a universal guarantee. Currency, subscription prices and credentials remain unconfigured. The user has no platform administrator email yet; leave the allowlist empty. No real charges, prices or administrator grants may be invented. Keep manual/test billing clearly labeled. Full-scale 5 TB operation requires infrastructure validation and a scanner capable of inspecting the content.

## Review focus

1. A delayed response from a former workspace/session must never populate the current screen.
2. A normal workspace owner must not enumerate other clients or alter platform subscriptions.
3. Duplicate/out-of-order billing events must not apply entitlements or financial records twice.
4. Truncated/reordered/tampered encrypted chunks or excessive decompression must fail verification; bytes must not be silently accepted.
5. Large uploads, scanning, download, backup and migration must apply backpressure and avoid whole-file memory buffering.

## Task 1: compact client experience

**Files:** `public/index.html`, `public/styles.css`, `public/tokens.css`, `public/script.js`, local fonts/icons, `test/browser.js`, `test/ui-browser.js`.

- [x] Replace the original long form with a responsive application shell, separate workspace settings and native dialogs.
- [x] Use local fonts/icons, readable file states, search/filter, real progress/cancel, explicit destructive confirmations, retry and session handling.
- [x] Verify current flow against real S3, 320/375/414/768/1440px layouts, keyboard focus, 200% text and automated axe checks.
- [x] Split sending into File → Recipient → Access/protection → Review → Result. Keep one compact screen visible, preserve entered values on Back, validate each screen and move focus correctly.
- [x] Update browser tests for the complete wizard, backward edits, invalid input, cancellation and no-scroll compactness at standard viewports.
- [x] Finish filesystem/S3 packaged-image checks and review screenshots after all integrated features.

## Task 2: enterprise administration and dashboards

**Files:** add focused `src/platform.js`, `src/analytics.js` and subscription service as needed; extend `src/config.js`, `src/app.js`, `src/database.js`, `.env.example`; add dedicated client/admin UI modules and Mongo-backed tenant tests.

**Interfaces:** platform routes require a verified session plus an explicit configured administrator email. Tenant dashboards consume `req.org` and never accept an arbitrary organization ID. Analytics return bounded date series, storage/quota totals and transfer counts from persisted data. Billing overview returns entitlements, subscription status, configured price/currency (if any) and actual recorded invoices/events; absent records produce empty states.

- [x] Write tests for platform denial to normal users, cross-tenant analytics/billing denial, read-only viewer behavior, aggregate accuracy and empty histories.
- [x] Implement bounded analytics for upload/download bytes/counts over 7/30/90 days and present accessible charts plus a table alternative.
- [x] Implement client billing screen with current plan/limits, subscription state, real records and clearly labeled manual/test/provider mode.
- [x] Add server-side platform allowlist and a local CLI to configure the operator email without disclosing keys. Do not enable a real identity until supplied by the user/operator.
- [x] Implement paginated platform client search, client detail, explicit suspension/reactivation and guarded subscription updates with audit records.
- [x] Implement platform aggregate analytics; exclude internal/test payment states from real revenue totals.
- [x] Add Stripe and M-Pesa provider boundaries and configurable crypto integration, with authenticated reconciliation/idempotency and test-mode verification. Preserve a usable manual path while credentials/prices are absent.
- [x] Verify platform actions cannot bypass quota/downgrade constraints or expose file plaintext.

## Task 3: large-file encryption and compression

**Files:** add a focused streaming crypto/compression module; extend `src/storage.js`, `src/object-store.js`, `src/scanner.js`, `src/worker.js`, upload/download handlers, config/Compose limits, backup/migration/key rotation tools and security tests.

**Interfaces:** a versioned file envelope records cipher/codec, authenticated framing data, original/stored sizes and per-file key wrapping. Storage exposes bounded ciphertext and authenticated plaintext streams. Existing bounded buffer APIs remain for legacy compatibility, with explicit limits. Dashboard accounting continues to reserve logical file bytes; measured stored bytes/compression savings are separate.

- [x] Confirm runtime/library support using primary documentation and a small round-trip experiment. Select an established streaming AEAD rather than designing a new cipher.
- [x] Write tamper, wrong-key/header, truncation, reorder/duplication, decompression-limit, random-data and compressible-data tests before replacing the upload path.
- [x] Stream optional lossless compression before encryption. Auto mode skips already compressed/incompressible inputs; expose measured savings and never change the original file bytes.
- [x] Stream encryption/decryption through filesystem/S3 with backpressure and cancellation. Enforce configurable maximum original/stored sizes.
- [x] Add resumable upload sessions with bounded encrypted chunks, persisted offsets/checksums, retry/reselection and cancellation. Do not represent a large configurable limit as a verified 5 TB transfer.
- [x] Stream authenticated plaintext to ClamAV; update scanner limits, timeouts, worker lease/heartbeat renewal and failure/retry behavior for the chosen size.
- [x] Stream downloads with authorization checks and authenticated framing; fail incomplete streams and retain the original filename/type-neutral download policy.
- [x] Update encrypted snapshots/restores, migrations and key verification to stream objects. Preserve old snapshots/formats and resume/reversal behavior.
- [x] Verify large-file memory bounds, cancellation/partial cleanup, quarantine, key rotation and cross-backend recovery. Record measured throughput/ratio without generalizing beyond fixtures.
- [x] Document server-managed encryption and production key-service requirements; independent review remains required for external security assurances.

## Task 4: release evidence

- [x] Update README, operations, design and delivery status around the actual finished scope and configured limits.
- [ ] Run syntax, core, tenant/platform/storage/backup integration, UI failure, axe and real browser tests; verify both storage modes in CI.
- [ ] Inspect final desktop/mobile/wizard/admin/client dashboards, including empty/loading/error states, long labels and keyboard navigation.
- [ ] Stage only intended source/assets, run secret/ignore checks, commit and push PR updates, then verify remote checks.
- [ ] Publish a version tag for a verified commit and ask whether to merge to main. Do not merge without the user's approval for this PR.
