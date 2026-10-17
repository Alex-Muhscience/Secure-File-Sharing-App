const { test } = require('node:test');
const assert = require('node:assert/strict');
const { byteRange } = require('../src/ranges');
test('single byte ranges are bounded and support native download resume', () => {
  assert.deepEqual(byteRange(undefined, 100), { start: 0, end: 99, length: 100, partial: false });
  assert.deepEqual(byteRange('bytes=50-', 100), { start: 50, end: 99, length: 50, partial: true });
  assert.deepEqual(byteRange('bytes=2-4', 100), { start: 2, end: 4, length: 3, partial: true });
  assert.deepEqual(byteRange('bytes=-8', 100), { start: 92, end: 99, length: 8, partial: true });
  assert.equal(byteRange('bytes=0-999', 100).length, 100);
  assert.equal(byteRange('bytes=5497558138879-', 5 * 1024 ** 4).length, 1);
  assert.equal(byteRange(undefined, 0).length, 0);
  for (const header of ['bytes=100-', 'bytes=9-1', 'bytes=-0', 'bytes=0-1,5-6', 'bytes=999999999999999999-', 'items=1-2', 'bad'])
    assert.throws(() => byteRange(header, 100), error => error.status === 416);
  assert.throws(() => byteRange('bytes=0-', 0), error => error.status === 416);
});
