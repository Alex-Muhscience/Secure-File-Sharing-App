const { test } = require("node:test");
const assert = require("node:assert/strict");
const zlib = require("node:zlib");
const crypto = require("node:crypto");
const { decodeTransport } = require("../src/chunk-transport");
const { encodeSTP } = require("../src/stc-codec");
test("wire decoding enforces exact logical size/hash and never trusts compressed length or codec", async () => {
  const plain = Buffer.alloc(16384, 65),
    sha256 = crypto.createHash("sha256").update(plain).digest("hex");
  for (const [codec, bytes] of [
    ["none", plain],
    ["gzip", zlib.gzipSync(plain)],
    ["stp1", encodeSTP(plain)],
  ]) {
    assert.deepEqual(
      await decodeTransport(bytes, {
        codec,
        expectedSize: plain.length,
        sha256,
      }),
      plain,
    );
    await assert.rejects(
      decodeTransport(bytes, { codec, expectedSize: plain.length - 1, sha256 }),
    );
    await assert.rejects(
      decodeTransport(bytes, {
        codec,
        expectedSize: plain.length,
        sha256: "00".repeat(32),
      }),
    );
    await assert.rejects(
      decodeTransport(bytes.subarray(0, -1), {
        codec,
        expectedSize: plain.length,
        sha256,
      }),
    );
  }
  await assert.rejects(
    decodeTransport(zlib.gzipSync(Buffer.alloc(1024 * 1024)), {
      codec: "gzip",
      expectedSize: 100,
      sha256,
    }),
  );
  await assert.rejects(
    decodeTransport(plain, {
      codec: "unknown",
      expectedSize: plain.length,
      sha256,
    }),
  );
  await assert.rejects(
    decodeTransport(plain, {
      codec: "none",
      expectedSize: 17 * 1024 * 1024,
      sha256,
    }),
  );
});
