# Industry Compression Implementation Plan

Status: owner requested a revision on 2026-10-17; revision details and execution-method selection are pending. Implementation has not started.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (native execution recommended) or superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver format-aware compression/download/send/restore workflows with a genuine custom lossless codec, reproducible comparisons and local platform administration.

**Architecture:** Separate a bounded custom codec, adaptive codec registry, portable archive container and authorized export/restore routes. Reuse existing resumable transfers, worker inspection, quotas, server-managed encryption and compact frontend screens. New representations have explicit identities; legacy original downloads keep their existing semantics.

**Tech Stack:** Node 24, built-in zlib/worker_threads/crypto/streams, Express 5, MongoDB, private filesystem/Garage S3, vanilla JavaScript, Playwright/axe, ClamAV and Mailpit. No new product dependencies planned.

**Spec:** [Approved design](../specs/2026-10-17-industry-compression-design.md).

## Global Constraints

- Lossless restoration is the default assumption: original bytes, metadata inside the file, signatures and encodings must survive exactly.
- The existing 10 MiB local acceptance limit stays in place; the 1–5 TB target requires separate actual-size infrastructure validation.
- No custom encryption is introduced. Existing AES-GCM and keyed manifests authenticate stored parts.
- New installations still start without a platform administrator unless the operator explicitly configures one.
- Do not claim regulatory certification, universal codec dominance or guaranteed savings from industry labels or synthetic results.
- Preserve `.env.local`, `.env.s3`, encryption/backup keys, volumes and user-owned untracked skill files.
- Ask the owner before merging the new PR into main; no assistant attribution in commit messages.

## Review Focus

- A spoofed extension/category must not select a decoder or bypass scanning (Tasks 2, 4, 6).
- A signed-in user must not export another workspace's private job or repurpose an original-download grant (Task 4).
- An interrupted export or malicious archive must never produce a falsely verified restored file (Tasks 3, 5).
- A profile/action change during a slow upload must not attach its response to the new screen or recipient (Task 6).
- Tiny, empty, random and already-compressed inputs may yield larger archive containers; show actual bytes and offer the original (Tasks 1, 3, 6, 7).

## File ownership and contracts

| File | Responsibility |
| --- | --- |
| `src/stc-codec.js` | Custom `STP1` predictive block encoder/strict decoder; no third-party compression |
| `src/compression.js`, `src/compression-worker.js` | Versioned codec registry, bounded encoder work and candidate selection |
| `src/file-profiles.js` | Six allowlisted category IDs, industry guidance and bounded format hints |
| `src/compressed-archive.js` | Versioned `STC1` single-file container and streaming decode |
| `src/compression-routes.js` | Authorized representations, private jobs, restore integration and summaries |
| `src/parts.js`, `src/storage.js`, `src/segments.js`, `src/app.js`, `src/worker.js` | Integrate codecs, job metadata, inspection, grants and notifications |
| `scripts/stc.cjs`, `scripts/benchmark-codecs.cjs` | Offline restore and reproducible measured comparisons |
| `public/compression-ui.js`, `public/compression.css` | Focused compact compression/restore screens, preserving the existing send path |
| `public/index.html`, `public/script.js`, `public/resumable.js` | Entry points, existing context lifecycle and resumable job settings |
| `test/stc-codec.test.js`, `test/compression.test.js`, `test/compressed-archive.test.js`, `test/compression.cjs`, `test/compression-browser.js` | Behavior/security/compatibility/browser coverage |

### Task 1: Custom predictive codec and compatibility vectors

**Interfaces:** `encodeSTP(bytes: Buffer): Buffer`; `decodeSTP(bytes: Buffer, expectedSize: number): Buffer`. Original length bounded to 64 MiB. Empty input is valid in the standalone codec. Predictor strides are allowlisted `{0,1,2,4,8,16}`; zero means literal. Blocks contain at most 256 residual bytes. Predict with prior byte at the chosen stride, encode the modulo-256 residual using the minimum 0–8 bits required for that block, and choose the smallest complete representation. Retain a raw representation if it wins. Header binds magic/version, stride, logical size and SHA-256. Unused padding bits must be zero.

- [ ] Write tests `custom codec restores literal, constant, ramp and strided data exactly` and `strict decoder rejects malformed lengths, padding, checksum, truncation and trailing data`; include zero/one byte, all 256 values, block boundaries, seeded random inputs, fixed golden bytes, length bombs and unknown predictors.
- [ ] Run `node --test test/stc-codec.test.js`; confirm the missing implementation is the failure.
- [ ] Implement the deterministic independent bitstream in `src/stc-codec.js`; every loop consumes input or produces bounded output and validates before allocation.
- [ ] Run the test file and require all cases to pass; document the actual bitstream and known limitations in `docs/COMPRESSION.md`.
- [ ] Commit only codec, contract documentation and tests: `feat(compression): add predictive lossless codec`.

### Task 2: Codec registry, format profiles and encrypted parts

**Interfaces:** `encode(bytes, {mode, profile, research}): Promise<{codec, bytes}>`, `decode(bytes, codec, expectedSize): Promise<Buffer>` in `src/compression.js`. Codec IDs: `none`, `br`, `zstd`, `stp1`. Keep legacy modes `auto`, `maximum`, `none`; add `adaptive` and `research`. Research includes the custom encoder; adaptive compares Brotli/Zstandard/original. Maximum keeps the old Brotli contract. `profileFor(name, sample, selected): {id, detected, likelyCompressed, warning}` in `src/file-profiles.js`; IDs `documents`, `data`, `developer`, `images`, `media`, `archives`. Profile hints do not parse or execute contents.

- [ ] Add tests pinning byte-exact round trips for every codec, unknown-codec rejection, no expansion from adaptive candidate choice, old-mode compatibility, incorrect/misleading category hints, and custom codec authenticated in encrypted part AAD.
- [ ] Run `node --test test/compression.test.js test/segments.test.js`; confirm new behavior fails.
- [ ] Implement Node zlib Brotli/Zstandard adapters with bounded output, one expensive encoder at a time, bounded worker queue and fixed codec parameters; worker errors reject the job and permit later recovery. Avoid whole-file input buffering beyond the current part limit.
- [ ] Wire the registry into `src/parts.js` and part writes without altering legacy readers. Reject unknown codec IDs before decrypt/decode. Pass profile/mode as explicit immutable upload settings and preserve retry compatibility.
- [ ] Run the focused tests, including worker failure/cancellation and concurrent encoding memory bounds; commit as `feat(compression): select measured codecs for encrypted parts`.

### Task 3: Portable archive and offline restore

**Interfaces:** `archive(source: AsyncIterable<Buffer>, {name, size, mode, profile}): AsyncIterable<Buffer>` and `restore(source, {maxOutputBytes}): {metadata, stream}` (asynchronous metadata parsing allowed) in `src/compressed-archive.js`. Container magic `STC1`, header JSON capped at 4 KiB, frame payload at most 8 MiB + bounded overhead, logical frame at most 8 MiB. Each frame binds index, decoded length, explicit codec and SHA-256. A required end record binds frame count, total length and whole-file SHA-256. Reject any extra byte after the end record. Exported archives are unencrypted.

- [ ] Write tests for multi-frame and empty round trips, safe filename handling, whole-file hash/finality, split input boundaries, wrong order, concatenation, truncated/endless/oversized frames, unknown codecs and original-size limits.
- [ ] Run `node --test test/compressed-archive.test.js` and confirm failure.
- [ ] Implement streaming framing/decoding with backpressure and strict size/work bounds. Add CLI `node scripts/stc.cjs restore INPUT OUTPUT` using exclusive temporary output, atomic publication after verification and no overwrite/path traversal. No arbitrary archive-tree extraction.
- [ ] Verify outputs with `sha256sum` or Node SHA-256 and independent gzip interoperability tests; commit as `feat(compression): export and restore portable archives`.

### Task 4: Private jobs, authorized exports and actual metrics

**Interfaces:** Extend `POST /api/uploads` with immutable `purpose: send|compress|restore` (legacy default `send`), `profile`, `exportFormat: stc|gzip`, `compression`. Compress/restore jobs have no recipient; never substitute the owner's email. Persist these fields to transfers and resume summaries. Add `GET /api/file/:id/export/:format` and explicit representation-bound native tickets/grants; format allowlist `stc|gzip`. New API summaries include measured storage bytes and codec counts; export bytes are recorded separately only as actually emitted.

- [ ] Write `test/compression.cjs` integration cases for owner/workspace roles, no-recipient private jobs, no notification, quarantined/blocked/expired/revoked denial, cross-workspace denial, invalid representations, grant substitution denial, old ticket compatibility and revocation during export.
- [ ] Run the new integration file against an isolated real MongoDB and confirm failure.
- [ ] Implement `src/compression-routes.js`; share existing current file/subscription/membership checks rather than copying a weaker policy. Stream gzip or STC from verified originals. Emit no `Accept-Ranges` for regenerated archives; reject ranges explicitly. Tie ticket/grant representation to every subsequent authorization check.
- [ ] Update resumable completion and worker notifications for private purposes; preserve quota reservation/release and idempotent finalization. Prevent format/profile changes on resume. Audit actual export requests/bytes separately from logical original download bytes.
- [ ] Run authorization, resumable and compression integration files; commit as `feat(transfers): add private compression jobs and guarded exports`.

### Task 5: Inspected archive restore jobs

**Interfaces:** Restore purpose uploads accept STC1 bytes within current upload limits. Worker decodes through the strict archive reader into a separately reserved, encrypted reconstructed transfer; reconstructed size is bounded by scanner/upload/available quota limits. Status remains quarantined until the reconstructed bytes pass the real inspector. Parent/private ownership is retained; recovery is idempotent. Expose `restoredFileId` only after finalization and scanning state is known.

- [ ] Add integration tests for valid exact restoration, decompression bombs, malformed/finality failures, EICAR in a valid container, full quota, scanner failure, concurrent workers, cancellation/expiry and recovered worker retry without duplicate accounting or objects.
- [ ] Run focused restore cases and confirm missing behavior fails.
- [ ] Implement restore worker processing using bounded encrypted parts and persisted job state. Reserve logical output before reconstruction; failure/cancellation releases reservations and removes only owned objects. No plaintext whole-file temporary buffer and no user path writes.
- [ ] Verify both filesystem and S3 restore paths and cleanup, then commit as `feat(transfers): inspect and recover compressed archive restores`.

### Task 6: Compact category-specific client screens

**Interfaces:** `compressionUI.open(action)`, `compressionUI.reset()` and context-change hooks in a dedicated frontend module. Reuse existing `api`, `revision`, dialogs and resumable uploader. Entry actions `download`, `send`, `restore`. The new module owns its form state; old Send a file keeps its established selectors/behavior.

- [ ] Add browser cases for all six category choices, industry examples, each action, Back persistence, mismatched format warnings, immutable resume settings, late completion after context/action change, denied/quarantined jobs, retry/cancel and actual downloaded bytes.
- [ ] Run `node test/compression-browser.js` and confirm the new entry/actions are absent.
- [ ] Implement four compact screens File type → File → Options → Review, then honest Result. Keep recipient/expiry only on sends. Restore uses its own focused file/review/result path. Add local navy/scarlet/white styles using existing tokens, keyboard focus, labels, `aria-live`, reduced motion and no horizontal overflow at 320 px / 200% text.
- [ ] Show codec labels, actual export/storage sizes separately, exact restoration instructions, archive encryption status and original fallback. Never show invented savings or industry certifications.
- [ ] Verify new browser flows and the existing UI/race suites; inspect desktop/mobile screenshots and axe results. Commit as `feat(ui): add industry compression and restore screens`.

### Task 7: Reproducible comparisons and release documentation

**Interfaces:** `node scripts/benchmark-codecs.cjs [--input DIRECTORY]` writes JSON with source type, hashes, versions/settings, total encoded/container sizes, encode/decode durations, process RSS and every codec result. Synthetic fixtures are deterministic and clearly labeled. User corpus files are read-only and never uploaded or committed.

- [ ] Add tests that benchmark output includes all candidate outcomes, verifies every round trip and cannot report savings from decoded bytes or omit container overhead. Include already-compressed and random inputs with negative results when applicable.
- [ ] Run focused tests, implement the script and record a small reproducible corpus result in `docs/benchmarks/`; report wins and losses without claims about untested competitors.
- [ ] Update package version to `0.6.0`, README, `docs/COMPRESSION.md`, `docs/LARGE_FILES.md`, operations/API/delivery docs and the approved spec/plan status. Document experimental custom-engine limits, CLI usage, backward compatibility and still-unvalidated TB capacity.
- [ ] Verify `.gitignore`/`.dockerignore` keep runtime exports, credentials, customer corpus, screenshots and scratch out of commits; preserve user skill files. Commit as `docs(release): document measured compression workflows`.

### Task 8: Full verification, review and PR handoff

- [ ] Run `npm run check`, `npm run check:secrets`, `npm test`, all real MongoDB/Garage integration files, UI/race/new compression browser suites and production dependency audit. Keep MongoDB's existing 64000 open-file limit.
- [ ] Build packaged images and verify ClamAV clean/EICAR, Mailpit sends, native originals/exports and restores with both filesystem and S3; verify encrypted backup/restore, migration and key rotation preserve all new codecs and job metadata. Leave the healthy local S3 stack running.
- [ ] Complete the execution method's required independent branch review, resolve concrete findings and rerun affected checks. Push commits and update the draft PR around final behavior and actual evidence.
- [ ] Wait for CI at the exact PR head. Report results, custom codec wins/losses and external validation limits. Ask the owner whether to merge this PR; do not merge without new approval. Tag v0.6.0 only once final release scope and reviewed commit are settled.
