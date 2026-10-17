const sodium = require("libsodium-wrappers");
const MAGIC = Buffer.from("STBK2"),
  FRAME_SIZE = 1024 * 1024;
function releaseState(state) {
  if (typeof sodium.free === "function") return sodium.free(state);
  // Released 0.8.4 returns a WASM allocation; the upstream convenience free() is newer.
  const runtime = sodium.libsodium;
  runtime.HEAPU8.fill(
    0,
    state,
    state + runtime._crypto_secretstream_xchacha20poly1305_statebytes(),
  );
  runtime._free(state);
}
async function* sealArchive(source, key) {
  await sodium.ready;
  const { state, header } =
    sodium.crypto_secretstream_xchacha20poly1305_init_push(key);
  try {
    yield Buffer.concat([MAGIC, Buffer.from(header)]);
    for await (const value of source) {
      const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
      for (let offset = 0; offset < bytes.length; offset += FRAME_SIZE) {
        const encrypted = sodium.crypto_secretstream_xchacha20poly1305_push(
          state,
          bytes.subarray(offset, offset + FRAME_SIZE),
          MAGIC,
          sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE,
        );
        const length = Buffer.alloc(4);
        length.writeUInt32BE(encrypted.length);
        yield length;
        yield Buffer.from(encrypted);
      }
    }
    const final = sodium.crypto_secretstream_xchacha20poly1305_push(
      state,
      new Uint8Array(),
      MAGIC,
      sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL,
    );
    const length = Buffer.alloc(4);
    length.writeUInt32BE(final.length);
    yield length;
    yield Buffer.from(final);
  } finally {
    releaseState(state);
  }
}
async function* openArchive(source, key) {
  await sodium.ready;
  const iterator =
    source[Symbol.asyncIterator]?.() ||
    (async function* () {
      yield* source;
    })()[Symbol.asyncIterator]();
  let pending = Buffer.alloc(0),
    position = 0,
    ended = false,
    state;
  const read = async (length) => {
    const output = Buffer.alloc(length);
    let written = 0;
    while (written < length) {
      if (position === pending.length) {
        if (ended) throw new Error("Incomplete archive frame");
        const next = await iterator.next();
        if (next.done) {
          ended = true;
          throw new Error("Incomplete archive frame");
        }
        pending = Buffer.from(next.value);
        position = 0;
        if (!pending.length) continue;
      }
      const count = Math.min(length - written, pending.length - position);
      pending.copy(output, written, position, position + count);
      position += count;
      written += count;
    }
    return output;
  };
  try {
    if (!(await read(5)).equals(MAGIC))
      throw new Error("Invalid archive version");
    state = sodium.crypto_secretstream_xchacha20poly1305_init_pull(
      await read(sodium.crypto_secretstream_xchacha20poly1305_HEADERBYTES),
      key,
    );
    for (;;) {
      const length = (await read(4)).readUInt32BE();
      if (
        length < sodium.crypto_secretstream_xchacha20poly1305_ABYTES ||
        length >
          FRAME_SIZE + sodium.crypto_secretstream_xchacha20poly1305_ABYTES
      )
        throw new Error("Invalid archive frame length");
      const result = sodium.crypto_secretstream_xchacha20poly1305_pull(
        state,
        await read(length),
        MAGIC,
      );
      if (!result) throw new Error("Archive authentication failed");
      if (
        result.tag === sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL
      ) {
        if (result.message.length || position !== pending.length)
          throw new Error("Unexpected data after archive final tag");
        for (;;) {
          const next = await iterator.next();
          if (next.done) break;
          if (next.value.length)
            throw new Error("Unexpected data after archive final tag");
        }
        return;
      }
      if (
        result.tag !== sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE
      )
        throw new Error("Invalid archive frame tag");
      yield Buffer.from(result.message);
    }
  } finally {
    if (state) releaseState(state);
    await iterator.return?.();
  }
}
module.exports = { sealArchive, openArchive };
