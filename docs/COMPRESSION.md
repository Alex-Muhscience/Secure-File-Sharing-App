# Compression engine and portable formats

Current v0.6.0 codec/container contract and reproduction guide. For readiness/remaining research use [delivery status](DELIVERY_STATUS.md); for module ownership and the distinction between client archives and encrypted backups use [implementation](IMPLEMENTATION.md#formats-and-protection-boundaries). The UI/server restore and offline CLI accept Secure Transfer STC1 archives, not arbitrary ZIP/RAR/gzip extraction. Standard gzip exports use normal gzip tools.

Version v0.6.0 adds lossless compression/download/send/restore workflows. The default pilot still accepts 10 MiB, and full-scale terabyte validation is separate. Use Node 24.19+ in the 24.x line; Node's Zstandard API remains experimental and is isolated behind explicit codec IDs and tests.

## STP1 custom predictive codec

STP1 is our independently implemented lossless byte predictor and block packer. It is not an invention claim about prediction/bit packing and is not a renamed Brotli/Zstandard stream. It uses these established techniques in a documented versioned format; comparative strength must be measured.

An STP1 stream consists of ASCII `STP1`, a core payload and a 32-byte SHA-256 of the exact original. The core begins with one predictor stride byte and a little-endian uint32 original length. Stride zero stores literal original bytes. Other valid strides are 1, 2, 4, 8 and 16. Prediction is the previous original byte at that stride, or zero before enough history exists. The residual is the difference modulo 256.

For a predictive payload, each block of at most 256 original bytes begins with its minimal residual bit width (0–8). Residuals follow least-significant bit first; unused bits in the final byte must be zero. Blocks share prediction history within the part. The encoder chooses the shortest complete core among the six allowed choices, retaining literal bytes on ties. Golden core example: original `00010203` encodes as `0104000000010e`.

Both encoders and decoders cap an original part at 64 MiB. A decoder validates expected size, stride, input bounds, minimal widths, padding, complete consumption and SHA-256; it does not allocate based on an unconstrained file header. The portable core uses `Uint8Array`; Node/browser wrappers supply platform SHA-256. Checksums detect corruption, not hostile rewriting: stored parts remain authenticated with AES-256-GCM and the ordered keyed manifest. No new encryption algorithm is introduced.

This codec targets correlated byte streams and may lose badly to established codecs on text, compressed media and random bytes. It is evaluated as an explicit research candidate. Reaching 75% reduction for one fixture does not establish a universal lossless guarantee.

## Codec selection and upload transport

Legacy `auto`, `maximum` (Brotli 11) and `none` remain supported. `adaptive` compares inexpensive Brotli/Zstandard level 3 candidates after representative sampling; `smallest` includes Brotli 11 and Zstandard 9; `research` compares the custom codec with inexpensive established candidates. Only retain a part that saves at least 2%; otherwise retain its original bytes. Full archive overhead is counted separately. Expensive encoding is serialized in a bounded worker queue; canceling preparation does not commit new logical offsets.

The browser worker uses feature-detected gzip and, in research mode, STP1. `X-Chunk-Codec` is `none`, `gzip` or `stp1`; `X-Chunk-Logical-Length`, `Upload-Offset` and `X-Chunk-SHA256` refer to the original bytes. The server bounds both encoded bodies and decoded output, verifies the exact logical size/hash, then applies storage compression/encryption and normal inspection. Quotas never use a caller's compressed size. Old raw requests still work. Browser preparation buffers at most the current and next bounded chunk; durable commits remain sequential.

Node codec decoders cap output and reject trailing streams; Zstandard additionally caps its advertised history window at 16 MiB. Brotli large-window mode is not enabled. Portable frames do not accept arbitrary codec identifiers or external dictionaries. Authentication comes from GCM/manifests in storage; exported checksums are integrity checks, not cryptographic sender authentication.

## STC1 container

The container begins with ASCII `STC1`, then a little-endian uint32 JSON-header length and a UTF-8 header `{version:1,name,size}`. Header/descriptor JSON is capped at 4 KiB. Original names are sanitized basenames. Each following record has the same uint32-length/JSON descriptor prefix. A data descriptor is `{kind:"data",index,size,codec,storedSize,sha256}` followed by exactly `storedSize` bytes. Logical frames are at most 16 MiB; payloads are at most 16 MiB + 64 KiB. Codec IDs are `none`, `br`, `zstd`, `stp1`.

The mandatory final descriptor is `{kind:"end",count,size,sha256}` for the ordered complete original. Its count/size/hash must agree with the header and every frame; extra bytes are rejected. Consumers must exhaust the verified stream before publishing any output. The CLI writes a private exclusive temporary file and links it to the requested destination only after verification; existing files are never overwritten. It defaults to 10 MiB output, with explicit `--max-bytes N` up to 5 TiB. No arbitrary ZIP/tar tree extraction is provided.

Compatible exports reuse authenticated encoded parts and verify their decoded originals before emitting frames. Gzip uses a standard stream. Download grants bind the file and representation; logout, expiry, membership and subscription access are rechecked. Regenerated archives do not support byte ranges. Exports are not encrypted and contain no server keys or storage ciphertext.

## Evidence and reproduction

```bash
node scripts/benchmark-codecs.cjs > exports/codecs.json
node scripts/benchmark-codecs.cjs --input benchmark-input > exports/customer-codecs.json
```

Create the ignored output/input directories first. Operator corpus files are read-only, regular, at most 16 MiB; reports contain filenames/hashes but no source contents. Only synthetic evidence is committed. Every candidate records original/payload/complete-container bytes, settings, verified SHA-256, five-run time median/range and cumulative process high-water RSS. RSS is not an isolated per-codec measurement. The separate correlated-walk probe was designed for prediction and is excluded from frozen holdout scoring.

[Recorded comparison](benchmarks/2026-10-17-codec-comparison.json): complete custom STP1 archive 34,174 bytes from a 262,144-byte correlated-walk probe (86.9637% reduction), versus 61,213 bytes for the smallest tested established candidate (Brotli 11). The general nine-fixture set favors established codecs and includes size increases, a mixed-data miss near 75%, and an empty file with no percentage. These are synthetic observations, not customer averages or a world ranking.

`scripts/benchmark-transfers.cjs` supports `--mode baseline|candidate`, `--app-root`, `--revision`, `--profile wan|lan`, `--clients 1|4`, `--resume`, `--matrix`, `--file all|NAME`, `--repetitions 1..5`, plus isolated `--wire none|gzip`, `--download original|stc` and `--compression` variants. Run inside the private test network with `TEST_MONGO_URI` and a real scanner. It creates/drops only its own disposable `perf_*` databases and temporary objects.

WAN models 10 Mbit/s up / 50 Mbit/s down / 80 ms latency; LAN models 1 Gbit/s / 2 ms. The shared application-stream shaper is not a TCP congestion model. Counts cover file-chunk/attachment body bytes, excluding API metadata and HTTP/TCP/TLS overhead. Its client uses Node gzip level 1, not browser CPU measurements. Actual browser functionality, gzip/custom-worker behavior and native downloaded originals/archives are tested separately. Verify on target devices/networks before making deployment speed commitments.

Final v0.6.0 [per-file ratios, WAN/LAN timing ranges, concurrent/resumed results and default decision](benchmarks/2026-10-18-summary.md): 5/8 nonempty synthetic fixtures meet the 75% target using the best tested setting. Custom STP1 meets it on the specialized probe, not the general set. LAN/tiny-file regressions keep legacy defaults in place.
