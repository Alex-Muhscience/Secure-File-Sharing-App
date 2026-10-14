# Secure Transfer

A working local file-transfer foundation built with Node 24, Express, MongoDB and local email capture. Senders and recipients sign in using email codes. Files stream into AES-256-GCM encrypted storage; only the sender and designated recipient can download them. Senders can revoke access, and a retryable cleanup loop deletes revoked or expired objects.

## Run locally

Requires Docker Compose and Node 24 to generate local keys:

```bash
node scripts/init-local.cjs
docker compose --env-file /dev/null -f compose.app.yaml up -d --build --wait
```

Open **http://localhost:3081**. Verification codes and recipient notifications appear in the local inbox at **http://localhost:8025**. This stack does not send email to external addresses. The older disabled preview remains separately available on port 3080 if running.

1. Enter a sender email, request a code, and retrieve it from the inbox.
2. Verify the code, select a file up to 10 MB, enter the recipient email, and choose an expiry.
3. Copy the recipient link or open it from the inbox. In a separate tab, sign in as the recipient to download.
4. Use “Revoke and delete” as the sender to remove access immediately. Cleanup runs every minute.

```bash
docker compose --env-file /dev/null -f compose.app.yaml logs --tail=100 app
docker compose --env-file /dev/null -f compose.app.yaml down
```

Named volumes preserve MongoDB, ciphertext and captured email. Keep `.env.local`: its encryption key is needed for existing uploads. Do not regenerate keys while retaining files. The application deliberately does not load the legacy tracked `.env`.

## Verify

```bash
npm ci --ignore-scripts
npm run check
npm test
TEST_MONGO_URI=mongodb://127.0.0.1:27017 npm run test:integration
```

The integration test uses a uniquely named disposable database and removes it afterward. It verifies sender/recipient downloads, unauthorized access denial, OTP replay and concurrent consumption, attempt limits, oversized upload cleanup, ciphertext corruption, restart persistence, expiry, revocation and deletion retries. The local Compose database has no host port. To test against it, run:

```bash
docker compose --env-file /dev/null -f compose.app.yaml run --rm --no-deps --user root -v "$PWD/test:/app/test:ro" -e TEST_MONGO_URI=mongodb://mongo:27017 app npm run test:integration
docker compose --env-file /dev/null -f compose.app.yaml exec -T app node < scripts/smoke.cjs
```

## API

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | Process liveness |
| GET | `/ready` | Database and storage readiness |
| POST | `/api/request-otp` | `{email}` → challenge `sessionId` |
| POST | `/api/verify-otp` | `{sessionId, otp}` → session `token` |
| POST | `/api/logout` | Revoke current session |
| POST | `/api/upload` | Multipart `file`, `recipient`, `expiryHours` |
| GET | `/api/files` | Up to 100 sender/recipient records |
| GET | `/api/file/:id/download` | Authenticated attachment download |
| DELETE | `/api/file/:id` | Owner revocation and queued deletion |

Protected calls require `Authorization: Bearer <token>`. Tokens are random opaque secrets, stored as hashes in MongoDB, and expire after one hour. The browser keeps its token in memory; reloading requires signing in again. Codes expire after ten minutes, allow five verification attempts, and can be consumed once. Requesting a replacement invalidates the old challenge. Rate limits are shared through MongoDB and fail closed when the database is unavailable.

## Security model and current limits

This is a local development foundation, **not an enterprise production release**. Encryption uses a server-held key; server operators can decrypt files. No plaintext files are written to disk. Download plaintext is buffered in memory until authentication completes, with a 10 MB default file limit and four concurrent transfers per process. Existing legacy CBC files are not migrated or readable by this implementation.

MongoDB is isolated on an internal Docker network without a host port, with no authentication for this local-only stack. The app and mail inbox bind to loopback. Deployment to other environments requires authenticated services, HTTPS, secret management, backups, and security review. Existing secrets in Git history require provider-side rotation by their owners.

Malware scanning, tenant organizations, durable notification retries, cumulative storage quotas, SSO, billing, production key rotation, resumable transfers and external audit export remain future work. Downloads already sent cannot be recalled. Revocation prevents new download authorization but cannot retract an in-progress response. Expiry denies new downloads even if the cleanup worker is temporarily unavailable. Audit records currently have no automatic retention policy. Deleted transfer metadata remains for lifecycle tracking.

The historical audit and broader delivery plan are in [ENTERPRISE_AUDIT_AND_PLAN.md](ENTERPRISE_AUDIT_AND_PLAN.md). Legacy `models/`, `middleware/`, `utils.js`, deployment templates and preview assets are not loaded by the current app; they remain pending removal or migration. The old README's Web3 and enterprise claims no longer describe the implemented product.
