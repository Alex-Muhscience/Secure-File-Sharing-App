const crypto = require('node:crypto');
const core = require('../public/stc-codec-core');
const MAGIC = Buffer.from('STP1');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest();
function encodeSTP(bytes) {
  const packed = core.pack(bytes);
  return Buffer.concat([MAGIC, Buffer.from(packed), digest(bytes)]);
}
function decodeSTP(bytes, expectedSize) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 41 || bytes.length > core.MAX + 41 || !Buffer.from(bytes.subarray(0, 4)).equals(MAGIC)) throw new Error('Invalid STP1 representation');
  const plain = Buffer.from(core.unpack(bytes.subarray(4, -32), expectedSize));
  if (!crypto.timingSafeEqual(digest(plain), Buffer.from(bytes.subarray(-32)))) throw new Error('STP1 checksum mismatch');
  return plain;
}
module.exports = { encodeSTP, decodeSTP };
