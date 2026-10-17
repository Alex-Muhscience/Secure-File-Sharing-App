# v0.6.0 release review record

The local enterprise pilot adds six-category compression/download/send workflows, a real custom STP1 codec, standard-codec comparisons, portable STC1/gzip exports, inspected archive restores, actual usage/export counters and an explicit local platform administrator. Live checkout is still unconfigured. PR #8 requires its own owner merge decision.

The default upload/inspection limit is still 10 MiB. The configured 5 TiB ceiling is not a validated operating capacity. Lossless 75% reduction is a per-file target with visible misses; no all-file or world-leading claim is made. New compression is opt-in because the regression gate failed on some cases. Read the [full evidence](benchmarks/2026-10-18-summary.md) and [format/CLI documentation](COMPRESSION.md).

## Validation

Runtime source commit: `8929b5e`. All 24 real MongoDB/Garage integration tests passed without skips, including custom-coded encrypted parts through migration/key rotation/backup recovery and restore accounting repair. All 26 unit cases passed. Focused filesystem compression tests and full UI/accessibility/race suites passed. Packaged filesystem/S3 browser and real scanner/email/download/restore checks passed; saved-format reopening is covered by both the browser and recipient integration tests. Exact-head CI results are recorded on PR #8.

Local development: http://secure-transfer.localhost:3081, exact allowlisted email `admin@secure-transfer.localhost`, OTP inbox http://localhost:8025. This is an ignored local configuration; new installations retain an empty administrator allowlist. Existing keys/data/volumes are preserved.

## Independent review and recovery fixes

A fresh read-only whole-branch review found three Important issues and no Critical/Minor findings. All three entered one fix pass: retrying a saved job now locks its recipient/action/settings; internal restore stages are excluded from public resumable listings/completion/mutation (including unmarked stages lacking a public fingerprint); and reopened compression jobs/authorized recipients retain the saved gzip format. Focused regressions failed before the fixes and passed afterward. Scanner-outage recovery and both polling-failure/lost-completion-response retries are covered.

## Execution decisions and their costs

- Ruling: work in the existing dedicated feature checkout — the local pilot, credentials and user's untracked skill installation live here, and no tracked unrelated changes exist — cost if wrong: less filesystem isolation; explicit staging and isolated disposable test databases protect user work.
- Ruling: performance claims require evidence, not selected codec names — no guaranteed 75% for incompressible inputs and no ratio/speed gate silently lowered — cost if wrong: target may remain unmet for a file/category, explicitly reported.
- Ruling: benchmark CLI uses explicit --mode/--app-root/--revision invocations rather than silently checking out baseline/candidate in one process — protects checkout and makes source/image identity explicit — cost if wrong: operator must invoke both runs and compare reports.
- Ruling: first corpus is explicitly synthetic, including tiny PNG/PCM/gzip and incompressible holdouts — no customer corpus exists — cost if wrong: representative industry ratio claims remain unvalidated, visible in every release report.
- Ruling: Node HTTP fixtures use shared application-stream shaping and count file HTTP-body bytes, not TCP/TLS overhead or browser CPU — reproducible local evidence without claiming internet capacity — cost if wrong: real client/browser/network speed validation remains a separate deployment gate.
- Ruling: stop after the fixed codec grid and three single-variable transfer checks, retaining legacy defaults — WAN benefits coexist with >5% LAN/tiny-file regressions, and no representative client corpus exists — cost if wrong: additional predictor/sampling/browser preparation tuning and production promotion remain outstanding.
- Final: Ruling: rely on the separately OTP-verified ignored local admin configuration — review intentionally excluded credentials, and the executor verified actual local sign-in — cost if wrong: later local configuration drift can remove admin access until reconfigured.
- Final: Ruling: keep real customer-corpus, device/network, terabyte and merchant acceptance as external pilot gates — the approved scope and recorded evidence do not establish them — cost if wrong: production launch, broad ratio claims and scale commitments cannot be made from this release.
- Final: Ruling: accept read-only review without a second independent suite replay — executor and exact-head CI run the real suites; the reviewer inspected tests and reproduced findings without persistent mutations — cost if wrong: an environment-specific blind spot can remain despite green checks.
