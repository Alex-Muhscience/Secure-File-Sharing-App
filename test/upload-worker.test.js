const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const crypto = require("node:crypto");
const { decodeTransport } = require("../src/chunk-transport");
test("browser worker compresses before transmission and retains exact hashes and random fallback", async () => {
  let delivered;
  const context = vm.createContext({
    Uint8Array,
    DataView,
    Error,
    Number,
    Math,
    Blob,
    Response,
    CompressionStream,
    crypto: crypto.webcrypto,
    performance,
    postMessage: (message) => delivered(message),
  });
  context.importScripts = () =>
    vm.runInContext(
      fs.readFileSync(require.resolve("../public/stc-codec-core"), "utf8"),
      context,
    );
  vm.runInContext(
    fs.readFileSync(
      require.resolve("../public/upload-compression-worker"),
      "utf8",
    ),
    context,
  );
  for (const bytes of [Buffer.alloc(256000, 65), crypto.randomBytes(32000)]) {
    const result = await new Promise((resolve) => {
      delivered = resolve;
      context.onmessage({
        data: { id: 1, bytes: Uint8Array.from(bytes).buffer, mode: "adaptive" },
      });
    });
    assert.equal(result.error, undefined);
    assert.deepEqual(
      await decodeTransport(Buffer.from(result.wireBytes), {
        codec: result.wireCodec,
        expectedSize: bytes.length,
        sha256: result.sha256,
      }),
      bytes,
    );
    assert.equal(
      result.wireCodec,
      bytes[0] === 65 && bytes[1] === 65 ? "gzip" : "none",
    );
  }
});
