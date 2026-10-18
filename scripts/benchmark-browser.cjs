const http = require("node:http");
const fs = require("node:fs/promises");
const { constants } = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const assert = require("node:assert/strict");
const { corpus, hash, random } = require("./benchmark-corpus.cjs");
const { decodeTransport } = require("../src/chunk-transport");
const { summarize } = require("../src/benchmark-metrics");
const MAX = 16 * 1024 * 1024;
const MODES = ["none", "adaptive", "smallest", "research"];

function parseOptions(args) {
  const options = {
    appRoot: path.resolve(__dirname, ".."),
    revision: "unrecorded working tree; see served-source hashes",
    repetitions: 5,
    modes: ["none", "adaptive"],
    file: "all",
    input: null,
  };
  const names = {
    "app-root": "appRoot",
    revision: "revision",
    repetitions: "repetitions",
    modes: "modes",
    file: "file",
    input: "input",
  };
  const seen = new Set();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i].slice(2),
      value = args[i + 1];
    if (
      !args[i].startsWith("--") ||
      !Object.hasOwn(names, key) ||
      !value ||
      value.startsWith("--") ||
      seen.has(key)
    )
      throw new Error(
        "Use --app-root, --revision, --repetitions, --modes, --file or --input with one value each",
      );
    seen.add(key);
    options[names[key]] = value;
  }
  if (!/^(?:[1-9]|1\d|20)$/.test(String(options.repetitions)))
    throw new Error("Use 1–20 repetitions");
  options.repetitions = Number(options.repetitions);
  if (typeof options.modes === "string")
    options.modes = options.modes.split(",");
  if (
    !options.modes.length ||
    options.modes.some((mode) => !MODES.includes(mode)) ||
    new Set(options.modes).size !== options.modes.length
  )
    throw new Error("Use distinct modes: none,adaptive,smallest,research");
  options.appRoot = path.resolve(options.appRoot);
  if (options.input) options.input = path.resolve(options.input);
  return options;
}

async function readBounded(file) {
  const stat = await fs.lstat(file);
  if (!stat.isFile())
    throw new Error("Corpus inputs must be regular files, not symbolic links");
  const opened = await fs.open(
    file,
    constants.O_RDONLY |
      (constants.O_NOFOLLOW || 0) |
      (constants.O_NONBLOCK || 0),
  );
  try {
    const current = await opened.stat();
    if (!current.isFile())
      throw new Error("Corpus inputs must be regular files");
    if (current.size > MAX)
      throw new Error("Corpus inputs must be at most 16 MiB");
    const bytes = Buffer.alloc(current.size);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await opened.read(
        bytes,
        offset,
        bytes.length - offset,
        null,
      );
      if (!result.bytesRead)
        throw new Error("Corpus input changed while reading");
      offset += result.bytesRead;
    }
    if ((await opened.read(Buffer.alloc(1), 0, 1, null)).bytesRead)
      throw new Error("Corpus input changed while reading");
    return bytes;
  } finally {
    await opened.close();
  }
}

async function loadFixtures(options) {
  let fixtures;
  if (options.input) {
    fixtures = [];
    let total = 0;
    for (const entry of (
      await fs.readdir(options.input, { withFileTypes: true })
    ).sort((a, b) => a.name.localeCompare(b.name))) {
      if (
        entry.isDirectory() ||
        (options.file !== "all" && entry.name !== options.file)
      )
        continue;
      if (fixtures.length >= 64) throw new Error("Use at most 64 corpus files");
      const bytes = await readBounded(path.join(options.input, entry.name));
      total += bytes.length;
      if (total > 128 * 1024 * 1024)
        throw new Error("Corpus total exceeds 128 MiB");
      fixtures.push({
        name: entry.name,
        bytes,
        category: "operator-supplied",
        source:
          "Read-only local corpus; names and hashes are reported, contents are not",
        holdout: true,
      });
    }
  } else {
    fixtures = corpus();
    const large = [
      [
        "chunk-text.bin",
        Buffer.alloc(
          8 * 1024 * 1024,
          "Client records: keep the exact original bytes.\n",
        ),
      ],
      ["chunk-random.bin", random(8 * 1024 * 1024, "browser-random-v1")],
      ["limit-random.bin", random(MAX, "browser-limit-v1")],
    ];
    fixtures.push(
      ...large.map(([name, bytes]) => ({
        name,
        bytes,
        category: "chunk-workload",
        source:
          "Synthetic browser preparation workload, separate from general codec ratio scoring",
        holdout: true,
      })),
    );
    if (options.file !== "all")
      fixtures = fixtures.filter((row) => row.name === options.file);
  }
  if (!fixtures.length) throw new Error("No matching corpus files");
  return fixtures.map((row) => ({ ...row, sha256: hash(row.bytes) }));
}

async function runBenchmark({
  appRoot,
  revision,
  repetitions,
  modes,
  fixtures,
}) {
  assert.ok(
    fixtures.length &&
      fixtures.every(
        (row) => Buffer.isBuffer(row.bytes) && row.bytes.length <= MAX,
      ),
  );
  const sourceFiles = [
    "upload-compression.js",
    "upload-compression-worker.js",
    "stc-codec-core.js",
  ];
  const sources = new Map(
    await Promise.all(
      sourceFiles.map(async (name) => [
        name,
        await fs.readFile(path.join(appRoot, "public", name)),
      ]),
    ),
  );
  const { chromium } = require("playwright");
  let browser;
  const failures = [];
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      res.setHeader("Cache-Control", "no-store");
      res.setHeader(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'",
      );
      if (req.method === "GET" && url.pathname === "/") {
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        return res.end(
          '<!doctype html><title>Local browser preparation benchmark</title><script src="/upload-compression.js"></script>',
        );
      }
      if (req.method === "GET" && sources.has(url.pathname.slice(1))) {
        res.setHeader("Content-Type", "application/javascript");
        return res.end(sources.get(url.pathname.slice(1)));
      }
      const match = /^\/(fixture|verify)\/(\d+)$/.exec(url.pathname);
      const fixture = match && fixtures[Number(match[2])];
      if (fixture && req.method === "GET" && match[1] === "fixture")
        return res.end(fixture.bytes);
      if (fixture && req.method === "POST" && match[1] === "verify") {
        assert.equal(
          req.headers["x-logical-size"],
          String(fixture.bytes.length),
        );
        assert.equal(req.headers["x-sha256"], hash(fixture.bytes));
        let size = 0;
        const parts = [];
        for await (const part of req) {
          size += part.length;
          if (size > MAX + 65536)
            throw new Error("Encoded payload exceeds limit");
          parts.push(part);
        }
        const encoded = Buffer.concat(parts);
        // Empty files send no upload chunk. Check their empty preparation without
        // weakening the real API decoder's nonempty-chunk contract.
        if (!fixture.bytes.length) {
          assert.equal(req.headers["x-codec"], "none");
          assert.equal(encoded.length, 0);
        } else {
          const plain = await decodeTransport(encoded, {
            codec: req.headers["x-codec"],
            expectedSize: fixture.bytes.length,
            sha256: hash(fixture.bytes),
          });
          if (!plain.equals(fixture.bytes))
            throw new Error("Decoded bytes differ from fixture");
        }
        res.setHeader("Content-Type", "application/json");
        return res.end(JSON.stringify({ verified: true, wireBytes: size }));
      }
      res.writeHead(404).end();
    } catch (error) {
      failures.push(error.message);
      if (!res.headersSent) res.writeHead(400);
      res.end(`Benchmark verification failed: ${error.message}`);
    }
  });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    await context.addInitScript(() => {
      // Observe actual native workers so fallback cannot masquerade as fast encoding.
      window.benchmarkWorkerMessages = 0;
      window.benchmarkWorkerErrors = [];
      const NativeWorker = window.Worker;
      window.Worker = class extends NativeWorker {
        constructor(...args) {
          super(...args);
          this.addEventListener("message", ({ data }) => {
            window.benchmarkWorkerMessages++;
            if (data.error) window.benchmarkWorkerErrors.push(data.error);
          });
          this.addEventListener("error", (event) =>
            window.benchmarkWorkerErrors.push(event.message || "Worker failed"),
          );
        }
      };
    });
    const page = await context.newPage();
    page.on("pageerror", (error) => failures.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const results = [];
    for (let index = 0; index < fixtures.length; index++) {
      const fixture = fixtures[index];
      await page.evaluate(async (index) => {
        window.benchmarkInput = await (
          await fetch(`/fixture/${index}`)
        ).arrayBuffer();
      }, index);
      for (const mode of modes) {
        const rows = [];
        let warmup;
        for (let repeat = -1; repeat < repetitions; repeat++) {
          const row = await page.evaluate(
            async ({ index, mode }) => {
              const original = window.benchmarkInput,
                beforeMessages = window.benchmarkWorkerMessages;
              const started = performance.now();
              const result = await uploadCompression.prepareChunk(original, {
                mode,
                estimatedMbps: 10,
              });
              const prepareMs = performance.now() - started;
              if (
                window.benchmarkWorkerMessages !== beforeMessages + 1 ||
                window.benchmarkWorkerErrors.length
              )
                throw new Error(
                  "Native worker failed or preparation silently fell back",
                );
              if (original.byteLength !== result.logicalSize)
                throw new Error("Preparation detached the caller's input");
              const originalHash = Array.from(
                new Uint8Array(await crypto.subtle.digest("SHA-256", original)),
                (byte) => byte.toString(16).padStart(2, "0"),
              ).join("");
              if (originalHash !== result.sha256)
                throw new Error(
                  "Preparation changed the caller's input or hash",
                );
              const response = await fetch(`/verify/${index}`, {
                method: "POST",
                headers: {
                  "X-Codec": result.wireCodec,
                  "X-Logical-Size": String(result.logicalSize),
                  "X-SHA256": result.sha256,
                },
                body: result.wireBytes,
              });
              if (!response.ok)
                throw new Error(
                  `Original-byte verification failed: ${await response.text()}`,
                );
              const verified = await response.json();
              if (verified.wireBytes !== result.wireBytes.byteLength)
                throw new Error("Wire byte count mismatch");
              return {
                prepareMs,
                workerMs: result.processingMs,
                logicalBytes: result.logicalSize,
                wireBytes: verified.wireBytes,
                wireCodec: result.wireCodec,
                verified: verified.verified,
              };
            },
            { index, mode },
          );
          if (repeat === -1) warmup = row;
          else rows.push(row);
        }
        const { bytes, ...metadata } = fixture;
        results.push({
          ...metadata,
          originalBytes: bytes.length,
          mode,
          warmup,
          rows,
          summary: summarize(rows),
        });
      }
    }
    assert.deepEqual(failures, []);
    return {
      version: 1,
      measuredAt: new Date().toISOString(),
      runtime: process.version,
      browser: { name: "Chromium", version: browser.version(), headless: true },
      host: {
        platform: process.platform,
        architecture: process.arch,
        cpu: os.cpus()[0]?.model,
        logicalCpus: os.cpus().length,
      },
      source: {
        revision,
        files: Object.fromEntries(
          [...sources].map(([name, bytes]) => [name, hash(bytes)]),
        ),
      },
      method:
        "Actual browser client and native dedicated worker. One warmup per case is excluded from summaries. prepareMs includes worker messaging/cloning; workerMs is reported by the worker. Fixture loading, original-hash checks and Node server decoding/verification are outside the timed preparation. Native worker events are observed to reject silent fallback.",
      boundaries:
        "Local browser preparation only: no upload/download throughput, application server, scanner, storage, archive framing, billing, network congestion, target-device acceptance or peak-memory measurement. Encoded body sizes are wire payloads, not complete downloadable archives. Default fixtures are synthetic; existing holdout labels are retained.",
      results,
    };
  } finally {
    try {
      await browser?.close();
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  }
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const fixtures = await loadFixtures(options);
  console.log(
    JSON.stringify(await runBenchmark({ ...options, fixtures }), null, 2),
  );
}
if (require.main === module)
  main().catch((error) => {
    console.error("Browser benchmark failed:", error.message);
    process.exitCode = 1;
  });
module.exports = { parseOptions, loadFixtures, runBenchmark };
