const crypto = require("node:crypto");
const { promisify } = require("node:util");
const zlib = require("node:zlib");
const registry = require('./compression');
const compress = promisify(zlib.brotliCompress),
  decompress = promisify(zlib.brotliDecompress);
const MAX_PART = 64 * 1024 * 1024;
let maximumTail = Promise.resolve();
const sha256 = (bytes) =>
  crypto.createHash("sha256").update(bytes).digest("hex");
function partAAD(file) {
  if (
    !Number.isSafeInteger(file.index) ||
    file.index < 0 ||
    !Number.isSafeInteger(file.offset) ||
    file.offset < 0 ||
    !Number.isSafeInteger(file.size) ||
    file.size < 1 ||
    file.size > MAX_PART ||
    !registry.CODECS.includes(file.codec) ||
    !/^[a-f\d-]{36}$/.test(file.uploadId) ||
    !/^[a-f\d]{64}$/.test(file.sha256)
  )
    throw new Error("Invalid encrypted part metadata");
  return Buffer.from(
    JSON.stringify([
      "part-v1",
      file.objectId,
      file.uploadId,
      file.index,
      file.offset,
      file.size,
      file.codec,
      file.sha256,
    ]),
  );
}
async function encodePart(bytes, mode) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > MAX_PART)
    throw new Error("Part exceeds size limit");
  if (['adaptive','smallest','research'].includes(mode)) return registry.encode(bytes,{mode});
  if (!["auto", "maximum", "none"].includes(mode))
    throw new Error("Invalid compression mode");
  if (mode === "maximum") {
    // Bound expensive high-quality encoders to one per process, including their native memory.
    const job = maximumTail.then(() =>
      compress(bytes, {
        params: {
          [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
          [zlib.constants.BROTLI_PARAM_LGWIN]: 22,
        },
      }),
    );
    maximumTail = job.catch(() => {});
    const compressed = await job;
    if (compressed.length < bytes.length * 0.98)
      return { codec: "br", bytes: compressed };
  } else if (mode === "auto") {
    const options = {
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: 5,
        [zlib.constants.BROTLI_PARAM_LGWIN]: 22,
      },
    };
    const sampled =
      bytes.length <= 3 * 65536
        ? bytes
        : Buffer.concat([
            bytes.subarray(0, 65536),
            bytes.subarray(
              Math.floor(bytes.length / 2) - 32768,
              Math.floor(bytes.length / 2) + 32768,
            ),
            bytes.subarray(-65536),
          ]);
    const sample = await compress(sampled, options);
    if (sample.length < sampled.length * 0.95) {
      const compressed =
        sampled === bytes ? sample : await compress(bytes, options);
      if (compressed.length < bytes.length * 0.98)
        return { codec: "br", bytes: compressed };
    }
  }
  return { codec: "none", bytes };
}
async function decodePart(bytes, file) {
  const plain = await registry.decode(bytes,file.codec,file.size);
  if (plain.length !== file.size || sha256(plain) !== file.sha256)
    throw new Error("Part integrity verification failed");
  return plain;
}
module.exports = { MAX_PART, partAAD, encodePart, decodePart, sha256 };
