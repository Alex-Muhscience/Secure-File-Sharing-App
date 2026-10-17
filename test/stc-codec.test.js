const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const vm = require('node:vm');
const fs = require('node:fs');
const { encodeSTP, decodeSTP } = require('../src/stc-codec');
const core = require('../public/stc-codec-core');
test('custom predictor restores every byte across block boundaries, strides and random inputs', () => {
  const fixtures = [Buffer.alloc(0), Buffer.from([255]), Buffer.from(Array.from({length:256}, (_, i) => i)), Buffer.alloc(4096, 0), Buffer.alloc(4096, 65), Buffer.from(Array.from({length:8192}, (_, i) => Math.floor(i / 4) % 256))];
  for (const length of [2, 15, 255, 256, 257, 511, 1025, 8193]) fixtures.push(crypto.randomBytes(length));
  for (const bytes of fixtures) {
    const encoded = encodeSTP(bytes);
    assert.deepEqual(decodeSTP(encoded, bytes.length), bytes);
    assert.deepEqual(encodeSTP(bytes), encoded, 'deterministic representation');
  }
  assert.ok(encodeSTP(Buffer.alloc(8192)).length < 8192 / 4);
});
test('custom decoder rejects substitution, bad versions/predictors, truncation, expansion and trailing data', () => {
  const bytes = Buffer.alloc(513, 3), encoded = encodeSTP(bytes);
  for (let index = 0; index < encoded.length; index++) {
    const tampered = Buffer.from(encoded); tampered[index] ^= 0x80;
    assert.throws(() => decodeSTP(tampered, bytes.length));
  }
  assert.throws(() => decodeSTP(encoded, bytes.length - 1));
  assert.throws(() => decodeSTP(Buffer.concat([encoded, Buffer.from([0])]), bytes.length));
  assert.throws(() => decodeSTP(encoded.subarray(0, -1), bytes.length));
  assert.throws(() => decodeSTP(encoded, 64 * 1024 * 1024 + 1));
});
test('portable core has fixed vectors and agrees in a browser-like runtime without Node APIs', () => {
  const context = vm.createContext({ Uint8Array, DataView, Error, Number, Math });
  vm.runInContext(fs.readFileSync(require.resolve('../public/stc-codec-core'), 'utf8'), context);
  const original = Uint8Array.from([0, 1, 2, 3]);
  assert.equal(Buffer.from(core.pack(original)).toString('hex'), '0104000000010e');
  assert.deepEqual(Buffer.from(context.STPCore.pack(original)), Buffer.from(core.pack(original)));
  assert.deepEqual(Buffer.from(context.STPCore.unpack(core.pack(original), 4)), Buffer.from(original));
  assert.throws(() => core.unpack(Uint8Array.from([1,4,0,0,0,1,0xfe]), 4), /padding|canonical|Invalid/);
});
