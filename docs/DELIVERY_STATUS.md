# Delivery status and remaining work

As of **2026-10-18**, the product version is **v0.6.0**. The working application, enterprise screens and industry-compression workflows are on `main`; [PR #8](https://github.com/Alex-Muhscience/Secure-File-Sharing-App/pull/8) was merged with owner approval at `9cfbeaf`. The release tag points to reviewed source `24d8521`, which is included in that merge. The [merge CI run](https://github.com/Alex-Muhscience/Secure-File-Sharing-App/actions/runs/39072849467) passed.

**Delivery stage: local pilot.** Core workflows are implemented and exercised automatically. Production operation, real merchant acceptance, representative client usability and actual terabyte capacity are not accepted. There is no meaningful single “percent complete”: those are separate outcomes.

This document owns current readiness and remaining priorities. [README](../README.md) introduces the product; [implementation](IMPLEMENTATION.md) maps the code and release history; [operations](OPERATIONS.md) owns procedures. Historical plans are not the live backlog.

## What has been built

“Implemented” means code exists and has repository evidence. The final column identifies what still prevents broader claims or rollout.

| Area | Implemented and exercised | Remaining work or acceptance |
| --- | --- | --- |
| Identity and access | Email OTP, hashed expiring sessions, workspace/recipient authorization, role checks, revocation and scoped native-download grants | Production email/HTTPS, identity policy and independent security review; SSO/SCIM are not implemented |
| Client experience | Compact navy/scarlet/white screens, quick send, compress/download, compress/send, STC restore, six categories, search/filter, progress/pause/resume, keyboard/reflow/axe checks | Real client usability, human accessibility review, other browsers and final branding |
| Workspaces and quotas | Personal/team workspaces, owner/admin/member/viewer roles, atomic original-byte/file/seat reservations and cleanup | Representative organization/retention requirements and production policy validation |
| Client dashboards | Owner/admin 7/30/90-day usage, storage, original downloads, archive exports, plan limits and actual order/payment records | Customer reporting/retention requirements; billing totals are not complete accounting |
| Platform administration | Explicit server-side email allowlist, client search/pagination, guarded manual subscriptions, separate access suspension, audit reasons and aggregate analytics | Production operator identity and operating procedures; domain ownership alone never grants admin rights |
| File pipeline | Browser-worker wire compression, resumable logical offsets, encrypted bounded parts, manifest integrity, quarantine, native originals/ranges and guarded exports | Actual 1–5 TB interruption, inspection, load and recovery trials on provisioned infrastructure |
| Compression and restore | Independent STP1 predictor/block packer, Brotli/Zstandard comparison, STC1/gzip export, exact offline/server restore and scanner-outage recovery | Broad codec research and representative corpus/device/network work; published ratio/speed gates have misses |
| Inspection | Real ClamAV clean/EICAR flows, fail-closed quarantine, retry/lease renewal and an external full-byte HTTPS inspector contract | A proven inspector at the target file sizes; the HTTP contract is not a bundled terabyte scanning service |
| Payments | Stripe recurring/prepaid, M-Pesa prepaid, optional BitPay prepaid, consent/quotes, authenticated verification, idempotency and reconciliation | Accounts, prices/currency, merchant sandbox acceptance, operational order repair, refunds/disputes/fees/tax/accounting work; checkout remains off |
| Recovery and storage | Filesystem/private Garage S3, migration/reversal, encrypted STBK2 snapshots, STBK1 reads, isolated restore and root/part/session key rewrapping | Managed redundant infrastructure, offsite retention, production drills, monitoring and key-service deployment |

The working app is not the old interface-only preview. It also is not a generic ZIP/RAR extractor, image optimizer, media transcoder, end-to-end encrypted messenger or complete financial-accounting system. Industry labels provide guidance and byte-preserving processing; they do not establish industry-specific certification.

## Current limits and known gaps

| Topic | Current boundary |
| --- | --- |
| Accepted file size | Default **10 MiB**, constrained by upload/scanner limits and available workspace quota |
| Large-file target | Requested 1–5 TB; configuration ceiling **5 TiB**, not an actual-size validation result |
| Included scanner | Local ClamAV stream cap **25 MiB**; changing only `MAX_FILE_SIZE` is insufficient |
| Compression target | At least 75% complete-archive reduction per eligible file; no universal lossless guarantee |
| General corpus result | Best tested settings meet the target on **5/8 nonempty synthetic fixtures**; one empty fixture is N/A |
| Custom codec result | STP1 meets the target on **0/8** general nonempty fixtures; **86.9637%** reduction on the separate correlated-data probe |
| Transfer speed | WAN benefits on declared compressible fixtures; tiny-file/concurrent-LAN regressions exceed the 5% gate, so legacy defaults remain |
| Evidence coverage | Synthetic files, local application-stream shaping and Chromium; no representative customer corpus, browser-CPU benchmark or real internet congestion test |
| Encryption boundary | Server-managed AES-GCM/keyed manifests for storage; downloaded STC/gzip archives are unencrypted |
| Live billing | Off by default; no merchant account, commercial price or live settlement has been accepted |
| Email/admin | New clones use local Mailpit and an empty admin allowlist; this workspace separately enables `admin@secure-transfer.localhost` |
| Infrastructure | Single-instance local services; no bundled production redundancy, managed KMS/HSM or immutable external audit service |

Original logical bytes, encrypted storage bytes, complete archive bytes and transferred HTTP-body bytes are different measurements. Storage savings or the earlier 1 GiB counting-scanner run cannot prove archive reduction, malware inspection throughput or terabyte capacity. Read the [full measurement tables and method](benchmarks/2026-10-18-summary.md), [compression reference](COMPRESSION.md) and [large-file evidence](LARGE_FILES.md).

## What remains, in priority order

These are readiness priorities, not promised delivery dates or accepted customer requirements. Engineering owns code changes; operators provide infrastructure/accounts; the product owner makes commercial and acceptance decisions.

| Priority | Work | Type | Evidence needed to close it |
| --- | --- | --- | --- |
| 1 | Establish representative real files across the six categories and improve the ratio/speed tradeoffs, including reported LAN/tiny-file regressions | Engineering + client validation | Authorized corpus with hashes/rights, exact restore, full-artifact ratios, repeated WAN/LAN/concurrent/resume results and target-device/browser measurements; disclose every miss |
| 2 | Provision and validate the intended large-file service | Engineering + infrastructure | Actual-size 1–5 TB transfer/inspection tests, agreed quotas, interruption/restart, resource bounds, backup/restore, migration and key-rotation drills; a capable full-byte inspector |
| 3 | Harden and operate a production deployment | Engineering + operations | Rotated previously exposed provider credentials, HTTPS, authenticated database/storage, managed key custody, redundancy, offsite retention, alerting, rollback drills and independent security review |
| 4 | Configure and accept real payment providers | Merchant setup + engineering | Chosen prices/currency/accounts, sandbox renewals/cancellation/receipts, failure/replay tests and a reviewed ambiguous-order repair procedure |
| 5 | Finish payment operations beyond entitlement grants | Engineering + business operations | Agreed refund/dispute/fee/tax/accounting scope, implemented tools or documented provider-owned process, reconciliation and support ownership |
| 6 | Accept the client experience and product identity | Product + client validation | Final branding/domain/operator email, source-licensing/commercial terms, real email delivery, representative client tasks, human accessibility review and supported-browser/download-manager acceptance |
| 7 | Agree additional enterprise contracts | Product + engineering | Decide whether SSO/SCIM, regional residency/redundancy and external immutable audit retention are required; implement and verify the agreed scope |

The 75% and speed acceptance gaps remain open research/engineering work. Merchant configuration and production infrastructure are not substitutes for those gaps. Increasing a configuration number, selecting an industry, enabling a provider flag or passing fixture tests does not close the corresponding acceptance item.

## Evidence already available

- v0.6.0: **26 unit cases and 24 integration cases**, plus UI/accessibility/race suites and packaged filesystem/S3 browser, Mailpit and ClamAV workflows. [Reviewed-head CI](https://github.com/Alex-Muhscience/Secure-File-Sharing-App/actions/runs/39072235453) and [merged-main CI](https://github.com/Alex-Muhscience/Secure-File-Sharing-App/actions/runs/39072849467) passed. These are release-specific counts, not automatically updated totals.
- Tests cover tenant/platform boundaries, quota races, malformed/oversized archives, custom-codec integrity, immutable retries, internal restore-stage isolation, recipient gzip selection, native revocation, payment ordering, scanner outage/retry and cancellation cleanup. Real custom-coded parts survived S3 migration, key rotation and encrypted recovery to both backends.
- A fresh branch review found three Important issues; all were reproduced and fixed. No minor findings were deferred. [The release review](RELEASE_V060.md) records the fixes, choices and their costs.
- [Benchmark summary](benchmarks/2026-10-18-summary.md) links every general-fixture outcome, the specialized custom-codec probe, timing ranges and concurrent/resumed comparisons. No customer success, certification, SLA, production revenue or universal codec superiority is established by these checks.

## Scope and maintenance rules

Keep the local pilot defaults until a separately reviewed change and its evidence justify promotion. Live checkout remains off until accounts, catalog terms and acceptance exist. Do not bypass quarantine, invent savings, erase difficult fixtures or treat an admin access pause as cancellation of provider charges.

Legacy `middleware/`, `models/`, `utils.js`, root `tokens.css` and `docker-compose.yml` are retained historical artifacts, not the active runtime or deployment guide. The port-3080 preview is separate from the working port-3081 app. Their presence does not mean those old paths need to be wired back in. Any cleanup/migration is a separate reviewed change.

For each future change, update current capability/remaining-work claims here, source/architecture navigation in [implementation](IMPLEMENTATION.md), procedures in [operations](OPERATIONS.md), and format/payment contracts in their dedicated documents. Record historical milestones in the [release history](IMPLEMENTATION.md#release-history-and-evidence); do not reuse an old plan as the current readiness dashboard. New pull requests require their own owner merge approval; approval of PR #8 has already been fulfilled.
