# v0.6.0 release review record

The local enterprise pilot adds six-category compression/download/send workflows, a real custom STP1 codec, standard-codec comparisons, portable STC1/gzip exports, inspected archive restores, actual usage/export counters and an explicit local platform administrator. Live checkout is still unconfigured. PR #8 requires its own owner merge decision.

The default upload/inspection limit is still 10 MiB. The configured 5 TiB ceiling is not a validated operating capacity. Lossless 75% reduction is a per-file target with visible misses; no all-file or world-leading claim is made. New compression is opt-in because the regression gate failed on some cases. Read the [full evidence](benchmarks/2026-10-18-summary.md) and [format/CLI documentation](COMPRESSION.md).

## Validation

Runtime source commit: `8929b5e`. All 22 real MongoDB/Garage integration tests passed without skips, including custom-coded encrypted parts through migration/key rotation/backup recovery and restore accounting repair. Five compression integration tests also passed using filesystem storage. The full unit suite, browser checks, final independent review and exact-head CI are recorded in the final PR handoff.

Local development: http://secure-transfer.localhost:3081, exact allowlisted email `admin@secure-transfer.localhost`, OTP inbox http://localhost:8025. This is an ignored local configuration; new installations retain an empty administrator allowlist. Existing keys/data/volumes are preserved.

## Execution decisions and their costs

- Ruling: work in the existing dedicated feature checkout — the local pilot, credentials and user's untracked skill installation live here, and no tracked unrelated changes exist — cost if wrong: less filesystem isolation; explicit staging and isolated disposable test databases protect user work.
- Ruling: performance claims require evidence, not selected codec names — no guaranteed 75% for incompressible inputs and no ratio/speed gate silently lowered — cost if wrong: target may remain unmet for a file/category, explicitly reported.
- Ruling: benchmark CLI uses explicit --mode/--app-root/--revision invocations rather than silently checking out baseline/candidate in one process — protects checkout and makes source/image identity explicit — cost if wrong: operator must invoke both runs and compare reports.
- Ruling: first corpus is explicitly synthetic, including tiny PNG/PCM/gzip and incompressible holdouts — no customer corpus exists — cost if wrong: representative industry ratio claims remain unvalidated, visible in every release report.
- Ruling: Node HTTP fixtures use shared application-stream shaping and count file HTTP-body bytes, not TCP/TLS overhead or browser CPU — reproducible local evidence without claiming internet capacity — cost if wrong: real client/browser/network speed validation remains a separate deployment gate.
- Ruling: stop after the fixed codec grid and three single-variable transfer checks, retaining legacy defaults — WAN benefits coexist with >5% LAN/tiny-file regressions, and no representative client corpus exists — cost if wrong: additional predictor/sampling/browser preparation tuning and production promotion remain outstanding.
