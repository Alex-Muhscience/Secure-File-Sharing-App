# Functional foundation — 2026-10-14

Implemented new application modules under `src/` and switched `app.js` to them. The historical audit describes the pre-implementation state. The functional stack is now `compose.app.yaml`; `compose.local.yaml` retains the separate interface preview.

Completed: validated keys/configuration; independent code/session expiry; cryptographic code generation and keyed digest storage; atomic consumption; shared database rate limits; direct encrypted streaming uploads; AES-GCM authentication before download release; owner/recipient access checks; safe DOM rendering and strict CSP; file management UI; recipient links and local notifications; tombstones and retryable cleanup; readiness and HTTP draining; minimal dependency manifest; CI and real database integration tests.

Outstanding release gates: provider-side rotation of previously committed credentials; removal of tracked `.env` and `node_modules` through an index cleanup; legacy code and deployment migration; key rotation and old-file migration; malware quarantine; organizations/quotas; durable outbox; operational backup/restore and monitoring; external security review. The local SMTP service captures mail only.

Verified locally: three core encryption/configuration tests; Mongo-backed lifecycle integration suite; actual SMTP-to-Mailpit sign-in and notification delivery followed by byte-for-byte recipient download, revocation and logout; healthy application/database/mail containers; syntax and whitespace checks. Clean application dependency audit reports zero known vulnerabilities. CI now repeats the tests and live Docker smoke workflow, but remote CI has not been executed in this session.

## v0.3.0 local pilot update

The user confirmed local pilot workflows. The foundation is committed and tagged v0.2.0. The next release adds organizations and roles, scoped recipient grants, atomic quota reservations/reconciliation, ClamAV quarantine and scan limits, a dedicated leased worker, embedded durable notification jobs, usage accounting, idempotent billing sandbox events, audit export and operational status. The UI supports workspace/member management, plan simulation, scan status, cancellation and activity export. Files now use random per-file data keys wrapped by versioned server keys; an offline tool rewraps verified files. Authenticated encrypted snapshots and isolated restore tooling have been added and tested.

Git tracking no longer includes `.env` or `node_modules`; fixed deployment secret values were removed. `.gitignore` and `.dockerignore` cover arbitrary environment variants, runtime data, keyrings, backups, restore output and browser artifacts. `.env.example` remains tracked. Existing historical exposure is not erased by those changes.

Validation: core configuration/encryption/tamper/rotation tests; Mongo-backed security/lifecycle tests; tenant/role/quota/billing/worker retry tests; encrypted restore/corrupt-archive tests; live SMTP plus ClamAV clean/EICAR workflow; Chromium workspace creation/member management/sandbox plan/safe filename/download/export/revoke workflow. [Delivery status](DELIVERY_STATUS.md) records external gates and [operations](OPERATIONS.md) documents recovery and rollback limits. No provider-side credential rotation, customer pilot, paid billing integration, remote deployment or independent security review was performed.
