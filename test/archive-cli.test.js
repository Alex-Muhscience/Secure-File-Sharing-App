const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const zlib = require("node:zlib");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { archiveFromParts } = require("../src/compressed-archive");
const execute = promisify(execFile);
test("offline restore uses an explicit output cap, verifies before publication and never overwrites", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "archive-cli-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const bytes = Buffer.alloc(11 * 1024 * 1024, 65),
    encoded = zlib.brotliCompressSync(bytes),
    sha256 = crypto.createHash("sha256").update(bytes).digest("hex"),
    parts = [];
  for await (const part of archiveFromParts(
    [{ bytes: encoded, codec: "br", size: bytes.length, sha256 }],
    { name: "original.bin", size: bytes.length },
  ))
    parts.push(part);
  const input = path.join(directory, "input.stc"),
    output = path.join(directory, "output.bin"),
    script = path.join(__dirname, "../scripts/stc.cjs");
  await fs.writeFile(input, Buffer.concat(parts));
  await assert.rejects(
    execute(process.execPath, [script, "restore", input, output]),
    { code: 1 },
  );
  await assert.rejects(fs.stat(output), { code: "ENOENT" });
  await execute(process.execPath, [
    script,
    "restore",
    input,
    output,
    "--max-bytes",
    String(12 * 1024 * 1024),
  ]);
  assert.equal(
    crypto
      .createHash("sha256")
      .update(await fs.readFile(output))
      .digest("hex"),
    sha256,
  );
  await assert.rejects(
    execute(process.execPath, [
      script,
      "restore",
      input,
      output,
      "--max-bytes",
      String(12 * 1024 * 1024),
    ]),
  );
  assert.equal(
    (await fs.readdir(directory)).filter((name) => name.endsWith(".tmp"))
      .length,
    0,
  );
  assert.equal((await fs.stat(output)).mode & 0o777, 0o600);
});
