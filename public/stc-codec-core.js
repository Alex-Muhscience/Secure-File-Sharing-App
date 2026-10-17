(function (root) {
  "use strict";
  const MAX = 64 * 1024 * 1024,
    STRIDES = [0, 1, 2, 4, 8, 16],
    BLOCK = 256;
  const width = (value) => (value ? 32 - Math.clz32(value) : 0);
  function valid(bytes) {
    if (!(bytes instanceof Uint8Array) || bytes.length > MAX)
      throw new Error("Invalid STP input size");
  }
  function residual(bytes, index, stride) {
    return (bytes[index] - (index >= stride ? bytes[index - stride] : 0)) & 255;
  }
  function pack(bytes) {
    valid(bytes);
    let chosen = 0,
      size = 5 + bytes.length;
    for (const stride of STRIDES.slice(1)) {
      let candidate = 5;
      for (let start = 0; start < bytes.length; start += BLOCK) {
        let maximum = 0;
        const end = Math.min(bytes.length, start + BLOCK);
        for (let i = start; i < end; i++) maximum |= residual(bytes, i, stride);
        candidate += 1 + Math.ceil(((end - start) * width(maximum)) / 8);
      }
      if (candidate < size) {
        chosen = stride;
        size = candidate;
      }
    }
    const output = new Uint8Array(size),
      view = new DataView(output.buffer);
    output[0] = chosen;
    view.setUint32(1, bytes.length, true);
    if (!chosen) {
      output.set(bytes, 5);
      return output;
    }
    let cursor = 5;
    for (let start = 0; start < bytes.length; start += BLOCK) {
      let maximum = 0;
      const end = Math.min(bytes.length, start + BLOCK);
      for (let i = start; i < end; i++) maximum |= residual(bytes, i, chosen);
      const bits = width(maximum);
      output[cursor++] = bits;
      let bit = 0;
      for (let i = start; i < end; i++) {
        const value = residual(bytes, i, chosen);
        for (let j = 0; j < bits; j++, bit++)
          output[cursor + (bit >> 3)] |= ((value >> j) & 1) << (bit & 7);
      }
      cursor += Math.ceil(bit / 8);
    }
    return output;
  }
  function unpack(bytes, expectedSize) {
    if (
      !(bytes instanceof Uint8Array) ||
      !Number.isSafeInteger(expectedSize) ||
      expectedSize < 0 ||
      expectedSize > MAX ||
      bytes.length < 5 ||
      bytes.length > MAX + 5
    )
      throw new Error("Invalid STP size");
    const stride = bytes[0],
      size = new DataView(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength,
      ).getUint32(1, true);
    if (!STRIDES.includes(stride) || size !== expectedSize)
      throw new Error("Invalid STP header");
    if (!stride) {
      if (bytes.length !== size + 5) throw new Error("Invalid literal length");
      return bytes.slice(5);
    }
    if (!size || bytes.length < 5 + Math.ceil(size / BLOCK))
      throw new Error("Invalid STP blocks");
    const output = new Uint8Array(size);
    let cursor = 5;
    for (let start = 0; start < size; start += BLOCK) {
      if (cursor >= bytes.length) throw new Error("Truncated STP block");
      const bits = bytes[cursor++],
        count = Math.min(BLOCK, size - start),
        length = Math.ceil((count * bits) / 8);
      if (bits > 8 || length > bytes.length - cursor)
        throw new Error("Invalid STP block");
      let bit = 0,
        maximum = 0;
      for (let i = start; i < start + count; i++) {
        let value = 0;
        for (let j = 0; j < bits; j++, bit++)
          value |= ((bytes[cursor + (bit >> 3)] >> (bit & 7)) & 1) << j;
        maximum |= value;
        output[i] = (value + (i >= stride ? output[i - stride] : 0)) & 255;
      }
      if (width(maximum) !== bits)
        throw new Error("Invalid noncanonical bit width");
      if (bit % 8 && bytes[cursor + length - 1] >> (bit % 8))
        throw new Error("Invalid padding");
      cursor += length;
    }
    if (cursor !== bytes.length) throw new Error("Invalid trailing STP bytes");
    return output;
  }
  const api = { pack, unpack, MAX };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.STPCore = api;
})(globalThis);
