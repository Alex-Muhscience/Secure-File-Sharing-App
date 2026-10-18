# Browser upload preparation: measured optimization

Measured on 2026-10-18 with Node 24.21.0 and headless Chromium 156.0.8078.4 on Linux x64, Intel i7-11850H (16 logical CPUs). This is a shared development workstation with the local pilot and other applications running, not an isolated target-device lab. The complete [measurement ledger](2026-10-18-browser-upload.json) retains all source hashes, worker snapshots, exact commands, warmups and samples.

The repeated comparison reduced median adaptive preparation from **94.2 to 81.2 ms** for 8 MiB text, **55.9 to 34.3 ms** for 8 MiB random data, and **77.5 to 59.5 ms** for 16 MiB random data. These are preparation-time observations, not upload/download throughput or compression-ratio gains. Tiny/raw cases include regressions and overlapping ranges, recorded below. The existing end-to-end LAN/tiny-file gate remains open.

## Scope and correctness

The baseline uses public runtime files from `b5fe6bb1ebf8407a949f5682ee2f7df5c2f992f3`. The candidate changes only upload-worker allocation/copying: fixed typed-array sampling of the same three regions, and direct transfer of its full output buffer. The client's original buffer is still cloned into the worker and remains available for retries. Compression thresholds, codec formats and quick-send defaults are unchanged; adaptive decisions remain sensitive to measured preparation cost.

The bounded search covered three variants, then one repeated baseline/candidate pair. Each run uses all nine existing synthetic fixtures, retaining their holdout labels, plus separate 8 MiB text/random and 16 MiB random chunk workloads. All are project-generated data. Chunk workloads are excluded from general codec ratio scoring. No customer corpus or real office/photographic/video datasets were supplied.

Each of 24 fixture/mode cases has one recorded warmup and five timed repetitions. Across six runs, **720 timed samples and 144 warmups** passed verification. Each nonempty payload was decoded by the production transport decoder and matched the exact original bytes/hash; zero-byte input was checked as empty raw preparation because the application sends no empty chunk. All six runs retained the same wire sizes/codecs for every case. Native-worker events reject hidden raw fallback or worker failures. Independent browser checks cover raw/gzip/STP1, the sampling boundary and 16 MiB boundary, and deliberately corrupt output/throw in the worker to prove failure detection.

`prepareMs` measures the real browser client call, including worker messaging and input cloning. Fixture loading, caller-buffer checks and server decoding are excluded. `workerMs` ends before the final output handoff/copy, so it cannot measure the removed final copy; use `prepareMs` for comparisons. No network shaping, scanner, storage, archive framing, concurrency, next-chunk overlap, peak memory or supported-device acceptance is measured.

## Screening results

Values are median preparation milliseconds; every case is retained. Full ranges and per-sample codec/byte counts are in the ledger.

| Fixture / mode | Baseline | Sample only | Transfer only | Combined |
| --- | ---: | ---: | ---: | ---: |
| business-records.txt / none | 2.6 | 2.3 | 2.4 | 1.9 |
| business-records.txt / adaptive | 25.0 | 10.5 | 26.1 | 10.8 |
| ledger.csv / none | 2.2 | 1.9 | 1.4 | 1.4 |
| ledger.csv / adaptive | 27.5 | 12.9 | 28.6 | 15.6 |
| settings.js / none | 1.5 | 1.5 | 1.3 | 1.6 |
| settings.js / adaptive | 23.3 | 8.3 | 21.0 | 8.5 |
| pixel.png / none | 0.3 | 0.4 | 0.2 | 0.4 |
| pixel.png / adaptive | 0.3 | 0.4 | 0.3 | 0.4 |
| tone.wav / none | 1.1 | 1.6 | 1.2 | 1.4 |
| tone.wav / adaptive | 18.3 | 9.0 | 19.1 | 7.4 |
| records.txt.gz / none | 0.4 | 0.3 | 0.3 | 0.5 |
| records.txt.gz / adaptive | 1.4 | 1.0 | 0.9 | 1.6 |
| random.bin / none | 1.1 | 1.3 | 1.2 | 1.0 |
| random.bin / adaptive | 20.6 | 10.8 | 22.4 | 9.8 |
| mixed.bin / none | 1.2 | 1.4 | 1.2 | 1.1 |
| mixed.bin / adaptive | 22.5 | 13.0 | 21.2 | 11.7 |
| empty.txt / none | 0.3 | 0.4 | 0.2 | 0.4 |
| empty.txt / adaptive | 0.3 | 0.4 | 0.4 | 0.3 |
| chunk-text.bin / none | 31.3 | 27.0 | 26.1 | 24.2 |
| chunk-text.bin / adaptive | 99.2 | 81.2 | 89.3 | 89.3 |
| chunk-random.bin / none | 31.7 | 35.5 | 26.4 | 27.1 |
| chunk-random.bin / adaptive | 55.0 | 40.9 | 48.8 | 34.8 |
| limit-random.bin / none | 62.1 | 56.9 | 45.7 | 52.2 |
| limit-random.bin / adaptive | 89.1 | 66.0 | 68.2 | 59.5 |

Sample-only targets intermediate JavaScript number-array allocation. Transfer-only removes the full output copy. Combined tests both together. Transfer-only did not consistently help adaptive small fixtures. Sample-only was faster than combined for some cases, including 8 MiB text in this screening. Combined gave the strongest measured tradeoff for large random adaptive chunks and large raw chunks, and was selected for a separate confirmation. This is not a claim that it wins every fixture or is a global optimum.

The initial baseline and screening occurred at different times that day (timestamps are retained). The fresh confirmation pair below was run sequentially at 10:26–10:27 UTC, without another task-owned browser/test run competing with it. Other workstation activity was not controlled.

## Confirmation results

Wire-body sizes are counts, not complete downloadable archive sizes. They were identical between baseline and candidate. Values are milliseconds; ranges are individual observed minima/maxima, not confidence intervals.

| Fixture / mode | Original bytes | Wire body bytes | Baseline ms, median (min–max) | Candidate ms, median (min–max) |
| --- | ---: | ---: | ---: | ---: | ---: |
| business-records.txt / none | 696,320 | 696,320 | 2.9 (2.2–3.4) | 2.3 (1.9–2.3) |
| business-records.txt / adaptive | 696,320 | 2,472 | 22.0 (20.1–29.3) | 10.6 (8.8–11.9) |
| ledger.csv / none | 490,069 | 490,069 | 2.3 (2.0–2.7) | 1.7 (1.4–1.8) |
| ledger.csv / adaptive | 490,069 | 62,685 | 28.0 (25.4–30.2) | 16.4 (13.1–16.6) |
| settings.js / none | 346,289 | 346,289 | 1.5 (1.1–1.7) | 1.1 (1.0–1.8) |
| settings.js / adaptive | 346,289 | 16,077 | 21.0 (19.7–25.1) | 7.7 (5.9–8.4) |
| pixel.png / none | 68 | 68 | 0.3 (0.2–0.3) | 0.4 (0.2–0.5) |
| pixel.png / adaptive | 68 | 68 | 0.5 (0.3–2.0) | 0.1 (0.1–0.2) |
| tone.wav / none | 262,188 | 262,188 | 1.4 (0.9–1.6) | 1.2 (1.0–1.5) |
| tone.wav / adaptive | 262,188 | 1,559 | 18.1 (15.0–18.4) | 6.0 (5.8–6.7) |
| records.txt.gz / none | 2,472 | 2,472 | 0.4 (0.4–0.5) | 0.3 (0.2–0.4) |
| records.txt.gz / adaptive | 2,472 | 160 | 1.4 (1.3–1.6) | 1.2 (1.0–1.6) |
| random.bin / none | 262,144 | 262,144 | 1.2 (1.1–1.4) | 1.3 (1.2–1.3) |
| random.bin / adaptive | 262,144 | 262,144 | 20.3 (19.6–24.3) | 9.9 (9.7–10.4) |
| mixed.bin / none | 262,144 | 262,144 | 1.3 (0.9–1.5) | 1.1 (0.9–1.4) |
| mixed.bin / adaptive | 262,144 | 65,784 | 23.1 (19.6–24.7) | 11.1 (10.6–11.9) |
| empty.txt / none | 0 | 0 | 0.3 (0.2–0.3) | 0.3 (0.3–0.4) |
| empty.txt / adaptive | 0 | 0 | 0.4 (0.3–0.6) | 0.2 (0.2–0.3) |
| chunk-text.bin / none | 8,388,608 | 8,388,608 | 30.2 (27.1–35.2) | 23.8 (21.3–27.0) |
| chunk-text.bin / adaptive | 8,388,608 | 24,483 | 94.2 (84.8–97.3) | 81.2 (72.3–87.3) |
| chunk-random.bin / none | 8,388,608 | 8,388,608 | 31.9 (30.3–35.2) | 26.4 (25.9–27.1) |
| chunk-random.bin / adaptive | 8,388,608 | 8,388,608 | 55.9 (47.3–63.4) | 34.3 (33.7–36.8) |
| limit-random.bin / none | 16,777,216 | 16,777,216 | 61.7 (52.3–68.4) | 48.0 (47.4–50.7) |
| limit-random.bin / adaptive | 16,777,216 | 16,777,216 | 77.5 (70.8–93.0) | 59.5 (51.3–64.8) |

The three adaptive chunk medians improved by **13.8%, 38.6% and 23.2%**, respectively. Raw chunk medians improved by 17.2–22.2%. The 8 MiB text ranges overlap, and five observations do not establish a percentile or SLA. The 68-byte raw PNG moved from 0.3 to 0.4 ms; raw 256 KiB random input moved from 1.2 to 1.3 ms. Sub-millisecond absolute differences produce large percentages, and some signs reverse between runs; no tiny-file speed guarantee is inferred. All misses remain visible.

## Reproduce and roll back

Install dependencies/Chromium using the [development instructions](../../README.md#development), then use the [browser harness options](../COMPRESSION.md#native-browser-preparation). The ledger's `commands` records the original invocations. Its `workers` contains exact source snapshots and hashes for each variant; the client/core files are unchanged from the base revision.

To repeat the recorded baseline/candidate source pair from the repository root, without changing the checkout or pilot:

```bash
mkdir -p exports
python3 - <<'PY'
import json, pathlib, subprocess, tempfile

ledger = json.loads(pathlib.Path("docs/benchmarks/2026-10-18-browser-upload.json").read_text())
with tempfile.TemporaryDirectory(prefix="browser-upload-replay-") as temporary:
    for label in ("baseline", "candidate"):
        root = pathlib.Path(temporary) / label
        public = root / "public"
        public.mkdir(parents=True)
        for name in ("upload-compression.js", "stc-codec-core.js"):
            source = subprocess.check_output(["git", "show", ledger["baseRevision"] + ":public/" + name])
            (public / name).write_bytes(source)
        worker = ledger["workers"][label]
        (public / "upload-compression-worker.js").write_text(worker["source"])
        with open("exports/browser-replay-" + label + ".json", "w") as output:
            subprocess.run(["node", "scripts/benchmark-browser.cjs",
                            "--app-root", str(root), "--revision", "replayed-" + worker["sha256"],
                            "--repetitions", "5"], stdout=output, check=True)
PY
```

Compare names, hashes, sizes/codecs and every case's preparation median/range before interpreting a delta. Replaying on another browser/host can change results. Customer inputs/reports stay private; filenames and hashes can identify their contents.

Rollback restores the baseline sampling block and `wireBytes.slice().buffer` from the recorded baseline worker, then reruns `npm run test:ui` and the same comparison. It requires no format, database, storage or configuration migration. The [ratio and end-to-end transfer evidence](2026-10-18-summary.md) remains historical evidence with its original misses; representative files, target devices, real networks and terabyte validation remain in [delivery status](../DELIVERY_STATUS.md).

