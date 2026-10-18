const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const {
  parseOptions,
  runBenchmark,
} = require("../scripts/benchmark-browser.cjs");
const { hash, random } = require("../scripts/benchmark-corpus.cjs");

async function main() {
  const options = parseOptions([
    "--repetitions",
    "1",
    "--modes",
    "none,smallest,research",
  ]);
  const bits = random(32768, "correlated-walk-probe-v1"),
    walk = Buffer.alloc(262144);
  let value = 0;
  for (let i = 0; i < walk.length; i++) {
    value = (value + ((bits[i >> 3] >> (i & 7)) & 1)) & 255;
    walk[i] = value;
  }
  const fixtures = [
    { name: "empty.bin", bytes: Buffer.alloc(0) },
    { name: "sample-boundary.bin", bytes: Buffer.alloc(196609, 65) },
    {
      name: "limit-random.bin",
      bytes: random(16 * 1024 * 1024, "browser-test-limit-v1"),
    },
    { name: "correlated-walk-probe.bin", bytes: walk },
  ].map((row) => ({ ...row, sha256: hash(row.bytes) }));
  const report = await runBenchmark({ ...options, fixtures });
  assert.equal(report.results.length, 12);
  assert.ok(
    report.results.every((row) => row.rows.every((sample) => sample.verified)),
  );
  assert.ok(report.results.every((row) => row.summary.repetitions === 1));
  assert.ok(
    report.results
      .filter((row) => row.mode === "none")
      .every((row) => row.rows[0].wireCodec === "none"),
  );
  assert.equal(
    report.results.find(
      (row) => row.name === "sample-boundary.bin" && row.mode === "smallest",
    ).rows[0].wireCodec,
    "gzip",
  );
  assert.equal(
    report.results.find(
      (row) =>
        row.name === "correlated-walk-probe.bin" && row.mode === "research",
    ).rows[0].wireCodec,
    "stp1",
  );
  await fs.mkdir("test-results/browser-upload", { recursive: true });
  await fs.writeFile(
    "test-results/browser-upload/correctness.json",
    JSON.stringify(report, null, 2),
  );

  const temporary = await fs.mkdtemp(
    path.join(os.tmpdir(), "browser-worker-negative-"),
  );
  try {
    await fs.mkdir(path.join(temporary, "public"));
    for (const name of [
      "upload-compression.js",
      "upload-compression-worker.js",
      "stc-codec-core.js",
    ])
      await fs.copyFile(
        path.join(options.appRoot, "public", name),
        path.join(temporary, "public", name),
      );
    const workerPath = path.join(
      temporary,
      "public/upload-compression-worker.js",
    );
    const worker = await fs.readFile(workerPath, "utf8");
    await fs.writeFile(
      workerPath,
      worker +
        `\nconst realPostMessage = postMessage;
postMessage = (message, transfers) => {
  if (message.wireBytes?.byteLength) new Uint8Array(message.wireBytes)[0] ^= 1;
  realPostMessage(message, transfers);
};\n`,
    );
    const single = {
      ...options,
      appRoot: temporary,
      modes: ["none"],
      fixtures: [fixtures[1]],
    };
    await assert.rejects(
      runBenchmark(single),
      /verification failed|checksum|changed the caller/i,
    );
    await fs.writeFile(
      workerPath,
      worker +
        '\nonmessage = () => { throw new Error("Deliberate worker failure"); };\n',
    );
    await assert.rejects(
      runBenchmark(single),
      /worker failed|silently fell back/i,
    );
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
  console.log(
    "PASS: native browser worker preserves caller bytes, raw/gzip/STP1 integrity and boundary sizes; benchmark rejects corrupted payloads and hidden worker fallback",
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
