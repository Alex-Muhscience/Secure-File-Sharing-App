const crypto = require("node:crypto");
const path = require("node:path");
const { encode, decode, CODECS } = require("./compression");
const MAX_FRAME = 16 * 1024 * 1024,
  MAX_HEADER = 4096,
  MAX_FILE = 5 * 1024 ** 4;
class ArchiveError extends Error {
  constructor(message) {
    super(message);
    this.name = "ArchiveError";
  }
}
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const safeName = (name) =>
  path
    .basename(String(name).replaceAll("\\", "/"))
    .replace(/[\x00-\x1f\x7f]/g, "")
    .slice(0, 200)
    .toWellFormed() || "download";
function record(value) {
  const json = Buffer.from(JSON.stringify(value));
  if (json.length > MAX_HEADER) throw new Error("Archive metadata too large");
  const size = Buffer.alloc(4);
  size.writeUInt32LE(json.length);
  return Buffer.concat([size, json]);
}
function metadata(name, size) {
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_FILE)
    throw new Error("Invalid archive size");
  return { version: 1, name: safeName(name), size };
}
async function* archiveFromParts(parts, settings) {
  const info = metadata(settings.name, settings.size),
    digest = crypto.createHash("sha256");
  yield Buffer.from("STC1");
  yield record(info);
  let count = 0,
    total = 0;
  for await (const part of parts) {
    if (
      !Number.isInteger(part.size) ||
      part.size < 1 ||
      part.size > MAX_FRAME ||
      !Buffer.isBuffer(part.bytes) ||
      part.bytes.length > MAX_FRAME + 65536 ||
      !CODECS.includes(part.codec) ||
      !/[a-f\d]{64}/.test(part.sha256 || "") ||
      count >= 1000000 ||
      total + part.size > info.size
    )
      throw new Error("Invalid archive part");
    const plain = await decode(part.bytes, part.codec, part.size);
    if (sha(plain) !== part.sha256)
      throw new Error("Archive part checksum mismatch");
    digest.update(plain);
    total += plain.length;
    yield record({
      kind: "data",
      index: count++,
      size: plain.length,
      codec: part.codec,
      storedSize: part.bytes.length,
      sha256: part.sha256,
    });
    yield part.bytes;
  }
  if (total !== info.size) throw new Error("Incomplete archive source");
  yield record({
    kind: "end",
    count,
    size: total,
    sha256: digest.digest("hex"),
  });
}
async function* archive(source, { name, size, mode = "adaptive" }) {
  async function* parts() {
    let pending = [],
      length = 0;
    const pack = async (bytes) => {
      const encoded = await encode(bytes, { mode });
      return { ...encoded, size: bytes.length, sha256: sha(bytes) };
    };
    for await (const value of source) {
      if (!(value instanceof Uint8Array))
        throw new Error("Archive source must contain bytes");
      const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
      for (let offset = 0; offset < bytes.length;) {
        const count = Math.min(MAX_FRAME - length, bytes.length - offset);
        pending.push(bytes.subarray(offset, offset + count));
        length += count;
        offset += count;
        if (length === MAX_FRAME) {
          yield await pack(Buffer.concat(pending, length));
          pending = [];
          length = 0;
        }
      }
    }
    if (length) yield await pack(Buffer.concat(pending, length));
  }
  yield* archiveFromParts(parts(), { name, size });
}
function reader(source) {
  const iterator =
    source[Symbol.asyncIterator]?.() || source[Symbol.iterator]?.();
  if (!iterator) throw new Error("Invalid archive source");
  let buffer = Buffer.alloc(0),
    position = 0,
    done = false;
  async function read(length) {
    if (!Number.isInteger(length) || length < 0 || length > MAX_FRAME + 65536)
      throw new ArchiveError("Archive read exceeds bound");
    const output = Buffer.alloc(length);
    let written = 0;
    while (written < length) {
      if (position === buffer.length) {
        const next = await iterator.next();
        if (next.done) {
          done = true;
          throw new ArchiveError("Incomplete archive");
        }
        if (!(next.value instanceof Uint8Array))
          throw new ArchiveError("Invalid archive input");
        buffer = Buffer.isBuffer(next.value)
          ? next.value
          : Buffer.from(next.value);
        position = 0;
        if (!buffer.length) continue;
      }
      const count = Math.min(length - written, buffer.length - position);
      buffer.copy(output, written, position, position + count);
      position += count;
      written += count;
    }
    return output;
  }
  async function json() {
    const length = (await read(4)).readUInt32LE();
    if (length < 2 || length > MAX_HEADER)
      throw new ArchiveError("Invalid archive descriptor");
    const bytes = await read(length);
    let value;
    try {
      value = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new ArchiveError("Invalid archive JSON");
    }
    if (!value || Array.isArray(value) || typeof value !== "object")
      throw new ArchiveError("Invalid archive descriptor");
    return value;
  }
  async function end() {
    if (position !== buffer.length)
      throw new ArchiveError("Trailing archive bytes");
    while (!done) {
      const next = await iterator.next();
      if (next.done) {
        done = true;
        break;
      }
      if (next.value.length) throw new ArchiveError("Trailing archive bytes");
    }
  }
  return {
    read,
    json,
    end,
    close: async () => {
      await iterator.return?.();
    },
  };
}
async function restore(source, { maxOutputBytes }) {
  if (
    !Number.isSafeInteger(maxOutputBytes) ||
    maxOutputBytes < 0 ||
    maxOutputBytes > MAX_FILE
  )
    throw new Error("Invalid restore limit");
  const input = reader(source);
  let info;
  try {
    if (!(await input.read(4)).equals(Buffer.from("STC1")))
      throw new ArchiveError("Unknown archive version");
    info = await input.json();
    if (
      info.version !== 1 ||
      typeof info.name !== "string" ||
      !info.name ||
      info.name !== safeName(info.name) ||
      !Number.isSafeInteger(info.size) ||
      info.size < 0 ||
      info.size > maxOutputBytes
    )
      throw new ArchiveError(
        "Archive exceeds output limit or has invalid metadata",
      );
  } catch (error) {
    await input.close();
    throw error;
  }
  async function* stream() {
    const digest = crypto.createHash("sha256");
    let count = 0,
      total = 0;
    try {
      for (;;) {
        const part = await input.json();
        if (part.kind === "end") {
          if (
            part.count !== count ||
            part.size !== total ||
            total !== info.size ||
            part.sha256 !== digest.digest("hex")
          )
            throw new ArchiveError("Archive final verification failed");
          await input.end();
          return;
        }
        if (
          part.kind !== "data" ||
          part.index !== count ||
          count >= 1000000 ||
          !Number.isInteger(part.size) ||
          part.size < 1 ||
          part.size > MAX_FRAME ||
          !Number.isInteger(part.storedSize) ||
          part.storedSize < 1 ||
          part.storedSize > MAX_FRAME + 65536 ||
          !CODECS.includes(part.codec) ||
          !/^[a-f\d]{64}$/.test(part.sha256 || "") ||
          total + part.size > info.size
        )
          throw new ArchiveError("Invalid archive frame");
        const encoded = await input.read(part.storedSize);
        let plain;
        try {
          plain = await decode(encoded, part.codec, part.size);
        } catch {
          throw new ArchiveError("Invalid compressed archive frame");
        }
        if (sha(plain) !== part.sha256)
          throw new ArchiveError("Archive checksum mismatch");
        digest.update(plain);
        total += plain.length;
        count++;
        yield plain;
      }
    } finally {
      await input.close();
    }
  }
  return { metadata: info, stream: stream() };
}
module.exports = {
  archive,
  archiveFromParts,
  restore,
  safeName,
  MAX_FRAME,
  ArchiveError,
};
