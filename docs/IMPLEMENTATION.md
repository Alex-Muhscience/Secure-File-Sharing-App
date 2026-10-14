# Functional foundation — 2026-10-14

Implemented new application modules under `src/` and switched `app.js` to them. The historical audit describes the pre-implementation state. The functional stack is now `compose.app.yaml`; `compose.local.yaml` retains the separate interface preview.

Completed: validated keys/configuration; independent code/session expiry; cryptographic code generation and keyed digest storage; atomic consumption; shared database rate limits; direct encrypted streaming uploads; AES-GCM authentication before download release; owner/recipient access checks; safe DOM rendering and strict CSP; file management UI; recipient links and local notifications; tombstones and retryable cleanup; readiness and HTTP draining; minimal dependency manifest; CI and real database integration tests.

Outstanding release gates: provider-side rotation of previously committed credentials; removal of tracked `.env` and `node_modules` through an index cleanup; legacy code and deployment migration; key rotation and old-file migration; malware quarantine; organizations/quotas; durable outbox; operational backup/restore and monitoring; external security review. The local SMTP service captures mail only.

Verified locally: three core encryption/configuration tests; Mongo-backed lifecycle integration suite; actual SMTP-to-Mailpit sign-in and notification delivery followed by byte-for-byte recipient download, revocation and logout; healthy application/database/mail containers; syntax and whitespace checks. Clean application dependency audit reports zero known vulnerabilities. CI now repeats the tests and live Docker smoke workflow, but remote CI has not been executed in this session.
