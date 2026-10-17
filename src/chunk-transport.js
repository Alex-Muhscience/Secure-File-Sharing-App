const { promisify } = require("node:util");
const zlib = require("node:zlib");
const crypto = require("node:crypto");
const { decodeSTP } = require("./stc-codec");
const gunzip = promisify(zlib.gunzip);
async function decodeTransport(
  bytes,
  { codec = "none", expectedSize, sha256 },
) {
  if (
    !Buffer.isBuffer(bytes) ||
    !["none", "gzip", "stp1"].includes(codec) ||
    !Number.isSafeInteger(expectedSize) ||
    expectedSize < 1 ||
    expectedSize > 16 * 1024 * 1024 ||
    bytes.length > 16 * 1024 * 1024 ||
    !/^([a-f\d]{64})$/.test(sha256 || "")
  )
    throw Object.assign(new Error("Invalid compressed chunk"), { status: 400 });
  let plain;
  try {
    plain =
      codec === "gzip"
        ? await gunzip(bytes, {
            maxOutputLength: expectedSize,
            rejectGarbageAfterEnd: true,
          })
        : codec === "stp1"
          ? decodeSTP(bytes, expectedSize)
          : bytes;
  } catch {
    throw Object.assign(
      new Error("Compressed chunk is invalid or exceeds its logical limit"),
      { status: 400 },
    );
  }
  if (
    plain.length !== expectedSize ||
    crypto.createHash("sha256").update(plain).digest("hex") !== sha256
  )
    throw Object.assign(new Error("Chunk size or checksum does not match"), {
      status: 400,
    });
  return plain;
}
module.exports = { decodeTransport };
