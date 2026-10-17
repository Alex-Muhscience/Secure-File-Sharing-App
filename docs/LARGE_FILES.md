# Large files: configuration, protection and evidence

The requested product target is 1–5 TB per file. The implementation provides bounded encrypted chunks and streaming operations, with a configuration ceiling of 5 TiB (5,497,558,138,880 bytes). A configurable limit is not a completed infrastructure validation. The default local pilot accepts 10 MiB; the supplied ClamAV stream limit is 25 MiB.

## Upload, compression and encryption

`UPLOAD_CHUNK_SIZE` accepts 8–16 MiB, default 8 MiB. Upload sessions reserve the original file size once, retain verified offsets/checksums, and expire after seven days. Sequential chunks have leases and duplicate/retry recovery. Completion authenticates the ordered manifest, persists a quarantined transfer and repairs accounting idempotently on retry. Cancellation/expiry/deletion remove partial encrypted objects and release quota. Users resume by reselecting the same unmodified file; its name, size, modification time and first/last 64 KiB fingerprint are a selection hint, not a complete local-file identity proof. Each transmitted chunk has its own full SHA-256 checksum.

Automatic compression samples beginning/middle/end data and uses Brotli quality 5 when useful. Maximum uses quality 11 with one encoder per process to limit native memory. It takes longer; encrypted or compressed data often will not shrink. Compression is retained only when it saves at least 2% of the part. Nothing is lossy. Original logical bytes determine quotas; actual ciphertext sizes determine measured savings.

Each `part-v1` object uses independent random AES-256-GCM key/nonce material. Its authenticated data binds parent upload, object ID, sequence, offset, original size, codec and plaintext SHA-256. Data keys are wrapped with the selected server key. The `segments-v1` root has a keyed manifest over the header and all ordered part descriptors. Missing/reordered/tampered data fail verification. Decompression has a 64 MiB per-part hard bound and checks exact authenticated size/checksum before release. Legacy GCM objects retain their bounded compatibility path. This is established cryptography with an application-specific storage format; it has not received an independent cryptographic audit.

## Inspection

Effective upload size is `min(MAX_FILE_SIZE, SCAN_MAX_FILE_SIZE)`. Oversized or incompletely inspected files cannot download. ClamAV INSTREAM uses backpressure and the included deployment has conservative limits. Do not advertise terabyte inspection by increasing configuration values alone.

For a separately provisioned inspector, configure:

```dotenv
SCANNER_MODE=http
SCANNER_HTTP_URL=https://your-private-inspector.example/inspect
SCANNER_HTTP_TOKEN=
MAX_FILE_SIZE=5497558138880
SCAN_MAX_FILE_SIZE=5497558138880
SCANNER_IDLE_TIMEOUT_MS=30000
```

Supply a real private HTTPS endpoint and an independent token of at least 32 characters. The application sends an octet-stream POST with exact `Content-Length`, bearer authentication and `X-File-ID`. A successful response must be HTTP 200, at most 4 KiB of JSON, with `clean` boolean and `scannedBytes` exactly equal to original size. The token and URL are never exposed to clients. The inspector must actually inspect every byte, reject policy-limited/encrypted archives appropriately, apply backpressure and return no clean verdict on partial inspection. A service returning invented byte counts cannot provide that assurance. The application validates the contract; no production terabyte inspector is bundled.

Worker scan leases/heartbeats renew during long inspections. Billing reconciliation, notifications and cleanup run independently of long scans. Scanner failures retain quarantine with retries; the UI identifies inspection limits. Production proxy/body/timeouts and inspector limits must be set and tested with your real profile.

## Download and recovery

Downloads authenticate the manifest before headers and each complete bounded part before releasing its plaintext. Single HTTP byte ranges support cross-chunk/suffix/native resume without decrypting the entire preceding file. Invalid/unsatisfiable or multipart ranges return 416. Range reads still traverse the bounded metadata manifest for integrity. Every streaming part rechecks current file, tenant membership, subscription and revocation; native downloads also recheck their scoped grant.

Native browser downloads use a one-use 60-second ticket, then redirect to a stable file URL with a host-only, path-scoped HttpOnly `SameSite=Strict` cookie (Secure on HTTPS). The grant expires with the transfer, at most seven days, so it can outlive the one-hour app session. It permits that attachment only; it is not an API session. Explicit logout revokes all download grants associated with the app session, even after that session expires. Do not copy cookies into scripts/logs. Browser restart/download-manager behavior still requires acceptance in browsers beyond the tested Chromium flow.

Encrypted backups use `STBK2`: libsodium XChaCha20-Poly1305 secretstream in bounded frames with mandatory authenticated finality. Restore authenticates the archive before mutations and then verifies each reconstructed file. Old `STBK1` archives remain readable. Metadata, active upload sessions/chunks and billing records are included; OTP/session/download credentials are excluded. Pause writes with `backup-local.sh`. Migration verifies/copies bounded ciphertext parts before switching references, preserving source copies. Key rotation authenticates data and rewraps roots/chunks/active sessions without rewriting file ciphertext. Keep historical keys for retained backups.

Filesystem listing uses directory streaming and orphan checks query metadata in batches of 1,000. Private S3 listing/multipart cleanup is paginated. End-to-end bandwidth, directory/object count, database index costs and whole-archive restore time must still be measured at the target scale. The local filesystem/S3 services provide no replica redundancy.

## Measured evidence

[Recorded 1 GiB fixture result](benchmarks/2026-10-17-one-gib.json): Node v24.21.0, filesystem, 8 MiB chunks, 32.84 s upload, 13.02 s verification, 18.92 s download, 180.4 MiB peak process RSS, exact downloaded SHA-256, 74.975% reduction. Each chunk contained 25% independent random bytes and 75% repeated A bytes. The scanner counted bytes only; this is not a malware-inspection benchmark. Timing/RSS are observations from one local run, not an SLO or capacity guarantee. It did not transfer a terabyte file or compare competitors.

Reproduce using `scripts/benchmark-large.cjs` with `BENCHMARK_BYTES` (64 MiB–4 GiB, multiples of 8 MiB), `TEST_MONGO_URI`, and a writable `BENCHMARK_ROOT` on adequately sized disk. It uses an isolated database and removes its own temporary data. The pilot app container's 64 MiB `/tmp` is too small for a 1 GiB fixture; bind a separate scratch directory owned by the process user. Do not point the benchmark at an existing application object directory.

Tests additionally exercise random/mixed/repetitive content, chunk retry/process replacement, cancellation/finalization races, tampering/truncation, stream limits, partial inspector responses, S3 migration/reversal, key rotation and restore to both storage modes. Before offering 1–5 TB commercially, run representative actual-size interrupted uploads/downloads, inspection, backup/restore, key rotation, migration, concurrent-client memory/CPU/network tests and failure drills on provisioned infrastructure. Production key management, external security review and client acceptance remain necessary.

Primary references: [Node zlib/Brotli](https://nodejs.org/api/zlib.html), [libsodium secretstream](https://doc.libsodium.org/secret-key_cryptography/secretstream), [ClamAV protocol](https://docs.clamav.net/manual/Usage/ClamdProtocol.html), [HTTP ranges](https://www.rfc-editor.org/rfc/rfc9110.html#section-14).
