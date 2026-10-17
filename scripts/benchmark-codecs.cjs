const fs = require("node:fs/promises");
const path = require("node:path");
const zlib = require("node:zlib");
const { promisify } = require("node:util");
const { corpus, hash, random } = require("./benchmark-corpus.cjs");
const { encodeSTP } = require("../src/stc-codec");
const { archiveFromParts, restore } = require("../src/compressed-archive");
const { ratio, summarize } = require("../src/benchmark-metrics");
const br = promisify(zlib.brotliCompress),
  zstd = promisify(zlib.zstdCompress),
  gzip = promisify(zlib.gzip),
  gunzip = promisify(zlib.gunzip);
const collect = async (source) => {
  const chunks = [];
  for await (const bytes of source) chunks.push(bytes);
  return Buffer.concat(chunks);
};
const candidates = [
  { name: "original", codec: "none" },
  ...[3, 5, 11].map((quality) => ({
    name: `brotli-q${quality}`,
    codec: "br",
    quality,
  })),
  ...[3, 9].map((level) => ({ name: `zstd-${level}`, codec: "zstd", level })),
  { name: "custom-stp1", codec: "stp1" },
  { name: "gzip-6", codec: "gzip", level: 6 },
];
async function benchmarkFixture(fixture, repetitions = 5) {
  if (
    !Buffer.isBuffer(fixture.bytes) ||
    fixture.bytes.length > 16 * 1024 * 1024
  )
    throw new Error("Benchmark fixtures must be at most 16 MiB");
  const originalBytes = fixture.bytes.length,
    sha256 = hash(fixture.bytes),
    cases = [];
  for (const candidate of candidates) {
    const rows = [];
    let artifactBytes = 0,
      payloadBytes = 0;
    for (let repeat = 0; repeat < repetitions; repeat++) {
      const before = performance.now();
      const packed =
        candidate.codec === "none"
          ? fixture.bytes
          : candidate.codec === "stp1"
            ? encodeSTP(fixture.bytes)
            : candidate.codec === "br"
              ? await br(fixture.bytes, {
                  params: {
                    [zlib.constants.BROTLI_PARAM_QUALITY]: candidate.quality,
                    [zlib.constants.BROTLI_PARAM_LGWIN]: 22,
                  },
                })
              : candidate.codec === "zstd"
                ? await zstd(fixture.bytes, {
                    params: {
                      [zlib.constants.ZSTD_c_compressionLevel]: candidate.level,
                    },
                  })
                : await gzip(fixture.bytes, { level: 6 });
      const encoded = performance.now();
      payloadBytes = packed.length;
      const artifact = ["none", "gzip"].includes(candidate.codec)
        ? packed
        : await collect(
            archiveFromParts(
              originalBytes
                ? [
                    {
                      bytes: packed,
                      codec: candidate.codec,
                      size: originalBytes,
                      sha256,
                    },
                  ]
                : [],
              { name: fixture.name, size: originalBytes },
            ),
          );
      const framed = performance.now();
      artifactBytes = artifact.length;
      let restored;
      if (candidate.codec === "none") restored = artifact;
      else if (candidate.codec === "gzip")
        restored = await gunzip(artifact, {
          maxOutputLength: Math.max(1, originalBytes),
        });
      else {
        const opened = await restore([artifact], {
          maxOutputBytes: originalBytes,
        });
        restored = await collect(opened.stream);
      }
      if (hash(restored) !== sha256 || restored.length !== originalBytes)
        throw new Error("Codec benchmark round trip failed");
      rows.push({
        encodeMs: encoded - before,
        frameAndVerifyMs: framed - encoded,
        restoreMs: performance.now() - framed,
        artifactBytes,
        payloadBytes,
        processPeakRssBytes: process.resourceUsage().maxRSS * 1024,
        verified: true,
      });
    }
    cases.push({
      ...candidate,
      artifactBytes,
      payloadBytes,
      ...ratio(originalBytes, artifactBytes),
      verified: true,
      summary: summarize(rows),
    });
  }
  return {
    name: fixture.name,
    category: fixture.category,
    source: fixture.source,
    holdout: fixture.holdout,
    originalBytes,
    sha256,
    cases,
  };
}
function probe() {
  const bits = random(32768, "correlated-walk-probe-v1"),
    bytes = Buffer.alloc(bits.length * 8);
  let value = 0;
  for (let i = 0; i < bytes.length; i++) {
    value = (value + ((bits[i >> 3] >> (i & 7)) & 1)) & 255;
    bytes[i] = value;
  }
  return {
    name: "correlated-walk-probe.bin",
    bytes,
    category: "data",
    source:
      "Specialized synthetic random-walk probe designed for byte prediction; excluded from frozen corpus/holdout scoring",
    holdout: false,
  };
}
async function main() {
  let fixtures = corpus();
  const args = process.argv.slice(2),
    index = args.indexOf("--input");
  if (index >= 0) {
    const directory = path.resolve(args[index + 1] || "");
    fixtures = [];
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const file = path.join(directory, entry.name),
        stat = await fs.lstat(file);
      if (stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024)
        throw new Error("Corpus files must be regular and at most 16 MiB");
      fixtures.push({
        name: entry.name,
        bytes: await fs.readFile(file),
        category: "operator-supplied",
        source:
          "Read-only local corpus; contents are not included in this report",
        holdout: true,
      });
    }
  }
  const results = [];
  for (const fixture of fixtures) results.push(await benchmarkFixture(fixture));
  const specializedProbe = await benchmarkFixture(probe());
  console.log(
    JSON.stringify(
      {
        version: 1,
        runtime: process.version,
        libraries: {
          zlib: process.versions.zlib,
          brotli: process.versions.brotli,
          zstd: process.versions.zstd,
        },
        repetitions: 5,
        measurement:
          "Full STC1 container bytes for br/zstd/stp1; standard gzip bytes; raw original baseline. RSS is the cumulative process high-water mark, not isolated per-codec memory.",
        variants: candidates,
        results,
        specializedProbe,
      },
      null,
      2,
    ),
  );
}
module.exports = { benchmarkFixture };
if (require.main === module)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
