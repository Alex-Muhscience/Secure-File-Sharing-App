# Industry workflows and a measured custom compression engine

Status: proposed written design; awaiting owner review. Working version: v0.6.0.

## Intent and agreed scope

The owner wants Secure Transfer to serve different industries and file formats through compact, separate screens. Users must be able to compress and download an archive or compress and send it. The core engineering goal is a custom compression algorithm with evidence of its strengths, rather than only a renamed third-party encoder. Local platform administration should use the working app name as its domain.

The owner selected all six initial file categories: documents/office files, structured data, developer files, images, audio/video, and mixed archives. The owner selected a custom codec compared with established codecs. Lossless restoration is the default assumption: original bytes, metadata inside the file, signatures and encodings must survive exactly. Industry selection guides recommendations; it is not a claim of regulatory certification or an access-control boundary.

Existing navy/scarlet/white styling, compact steps, workspace roles, subscriptions, scanning, encryption, resumability and original-file downloads remain part of the product. The existing 10 MiB local acceptance limit stays in place; the 1–5 TB target requires separate actual-size infrastructure validation.

## Alternatives and decision

1. **Selected: custom predictive codec plus an adaptive comparison engine.** Implement our own bounded predictive/block-packing codec, compare complete encoded sizes with Brotli and Zstandard, and retain originals when nothing saves space. This offers an independently implemented algorithm and measurable incremental improvements without making a universal performance claim.
2. A completely new general-purpose entropy codec first. This is a research programme with uncertain results and delays usable workflows. It remains a future research direction, not a release promise.
3. Established codecs only. Faster to ship, but does not meet the owner's custom-algorithm objective.

Neither an automatic selector nor a new container will be described as a newly invented general-purpose codec. The custom predictor/packer, selection policy and archive container will be documented separately. Existing codecs retain their proper names and licenses.

## User experience

Keep the existing transfer list and add a clear **Compress a file** entry. A short task chooser offers **Compress and download**, **Compress and send**, and **Restore an archive**. Existing **Send a file** remains available for compatibility and quick transfers.

The compression flow has four screens, with Back retaining values:

1. **File type:** choose one of six categories. A concise industry/use-case selector (general business, finance/legal, healthcare/research, engineering/data, creative/media, education) changes examples and guidance without silently changing security or converting formats.
2. **File:** select one file, see the detected format and expected compressibility. Extensions and MIME are hints; bounded signatures/content sampling guide recommendations. Mismatches are explained and may be overridden for generic binary processing. A type hint never replaces malware inspection.
3. **Options:** choose balanced, smallest result, or original; choose a portable gzip export or Secure Transfer archive. Advanced settings offer the experimental custom engine. Sending additionally asks for recipient and expiry. Download-only jobs require no recipient and are private to the submitting workspace/user under existing roles.
4. **Review and result:** show the action, original size, selected format and access settings before starting. After inspection, show actual archive bytes, storage bytes separately, measured savings and codec(s), with the intended download or share action. A larger archive is reported honestly, with an original-file alternative. A paused or failed operation remains recoverable.

JPEG/PNG, video/audio encodings, DOCX/XLSX/PPTX, PDF and archives are accepted as bytes. Already compressed inputs often have limited further savings. No lossy conversion, file-format rewrite, medical image interpretation, archive extraction, or signature stripping occurs. Unknown formats use the generic path. The first release processes one file per job; directory/batch archives can follow without changing the codec contract.

## Compression components

### Custom codec: STC predictor v1

Implement a real lossless encoder/decoder in a dedicated module, with no dependency on an existing compressor for its custom bitstream. Use bounded blocks, reversible byte-stride prediction (including raw/delta variants), and deterministic bit packing of residuals with a literal escape for blocks that do not benefit. Select prediction/block parameters by total encoded byte count, including headers. This targets correlated numeric/binary records and repeated patterns; it may lose to existing compressors on prose, complex media and other data.

The bitstream has explicit magic/version, original length, bounded block descriptors and a SHA-256 checksum. The decoder rejects unknown versions, impossible parameters, overlong/truncated payloads, noncanonical lengths, out-of-bounds expansion and trailing bytes. Decoding never trusts lengths to allocate outside a configured bound. Fuzz/property tests and fixed compatibility vectors precede activation. SHA-256 detects corruption; authenticity for stored parts continues to come from AES-GCM and the keyed manifest. No custom encryption is introduced.

### Adaptive selector

Place codec selection behind a small encode/decode interface. Preserve legacy `br` and `none` readers. Add explicit codec IDs for Zstandard and the custom v1 codec. Persist the chosen codec per part, authenticated by the current GCM associated data and ordered manifest. Never infer a decoder from the user-selected category.

Balanced mode uses representative bounded sampling and limited candidate work; smallest mode serializes expensive encoders and compares full candidate lengths. Custom research mode explicitly opts into evaluating STC v1. Only retain a candidate that beats the original by the configured threshold after format overhead. Defaults must not promise that the fastest/best sample is the global optimum. CPU/memory/concurrency bounds and cancellation apply to new encoders as to existing uploads.

Keep content-profile IDs distinct from codec IDs. Profiles can change candidate priority, not the original bytes, security policy or decoder. Store profile/engine versions for reproducibility. File names, extensions, category selections and industry hints remain untrusted metadata.

## Compressed export and restore

Storage compression currently reverses automatically during download; add an explicit export representation rather than changing legacy download semantics. Standard gzip is the interoperable option. A versioned `.stc` archive records safe original basename, exact logical size, ordered bounded frames, explicit frame codecs, frame checksums, aggregate checksum and mandatory finality. It contains compressed data, not server keys or storage ciphertext. The result screen states that exported archives are not encrypted.

Archive exports stream from already authenticated and inspected stored content through the same membership/subscription/revocation checks as original downloads. Scope native download grants to both the file and representation so an original-download grant cannot silently become a different export. Range/resume support is retained for existing originals; a streaming export without a persisted fixed representation does not advertise byte ranges. If the export is interrupted, users can request it again. Do not buffer whole files in browser memory.

A companion CLI restores `.stc` offline with exact-size/hash/finality checks, writes only a sanitized single filename into an explicitly selected destination, and avoids overwriting existing files. The in-app Restore path accepts our single-file format under the current size limits, validates bounded framing, scans the reconstructed original, and downloads only after inspection passes. It does not unpack arbitrary ZIP/tar trees. Invalid archives stay unavailable and release their reservations through normal cleanup.

For compress-and-send, recipients can download the original as today or an explicitly selected archive; recipient identity and expiry rules apply to both. Export checks cannot bypass quarantined/blocked/deleted state. Private download-only jobs do not enqueue recipient mail or manufacture recipient identities. Audit events and analytics distinguish original transfer bytes, compressed export bytes and encrypted storage bytes.

## Local administrator

Use `admin@secure-transfer.localhost` as the explicit local allowlisted operator, verified through the existing Mailpit OTP flow. Use `http://secure-transfer.localhost:3081` as the development origin; retain the localhost fallback. `.localhost` is a special-use local namespace, not a registered public domain. No hosts-file or global DNS changes are required for the tested Chromium flow. Document resolver-specific fallback for command-line tools.

Keep the identity in ignored `.env.local`, preserve every existing key and service credential, restart app/worker without deleting volumes, and verify both platform clients and analytics in the browser. Keep OTP authentication and exact-email server-side allowlisting; do not grant admin to everyone using that domain. New installations still start without a platform administrator unless the operator explicitly configures one. No external mailbox, public DNS, billing merchant account or production administrator is provisioned.

## Validation and evidence

- Fixed-vector and randomized round trips for the custom codec across empty/small/random/repetitive/stride-pattern data, incompressible fallbacks, every predictor choice and block boundary. Adversarial malformed inputs must fail within output/work bounds.
- Published, reproducible comparisons against Brotli, Zstandard, gzip and original bytes, using identical logical inputs. Record codec/library versions, settings, framing overhead, elapsed encode/decode time, peak RSS and restored SHA-256. Include structured data, source/text, office/container formats, images, media and random/encrypted-like input. Distinguish synthetic fixtures from supplied real-world files. Report wins and losses; no “best in existence” claim from a small corpus.
- Real MongoDB/filesystem/S3 integration tests for private jobs, sends, legacy reads, new codec authentication, exports, restore, quotas, scanner failure, revoked/expired access, cross-workspace access, worker recovery and cleanup. Ensure new codec IDs survive backup/restore, migration and key rewrapping.
- Browser checks for both actions and restore, back navigation, keyboard focus, screen reader names, mobile reflow, enlarged text, actual downloaded files, real Mailpit notifications and ClamAV clean/EICAR rejection. Keep security controls active for every format.
- Update README, large-file/operations docs, API contracts, version and delivery status. Open a feature PR and push reviewed commits without assistant attribution. Ask the owner before merging that PR into main; the earlier PR #7 approval does not authorize a new merge.

## Delivery boundaries

This release delivers usable workflows and a documented, tested first custom codec. Independent codec research/novelty, comprehensive competitor benchmarks, representative customer corpus results, 1–5 TB trials, production managed keys and regulatory certification are separate evidence gates. No target savings, universal dominance, custom-cryptography strength or compliance is inferred from industry labels.

Primary references: [Node 24 zlib API](https://nodejs.org/download/release/v24.21.0/docs/api/zlib.html), [Zstandard format (RFC 8878)](https://www.rfc-editor.org/rfc/rfc8878.html), [special-use localhost names (RFC 6761 §6.3)](https://www.rfc-editor.org/rfc/rfc6761.html#section-6.3).
