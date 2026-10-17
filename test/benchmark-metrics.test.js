const { test } = require('node:test');
const assert = require('node:assert/strict');
const metrics = require('../src/benchmark-metrics');
test('compression target includes the complete artifact and handles exact boundaries and empty originals', () => {
  assert.deepEqual(metrics.ratio(100, 25), { reduction: 0.75, targetMet: true });
  assert.equal(metrics.ratio(100, 26).targetMet, false);
  assert.equal(metrics.ratio(100, 101).reduction, -0.01);
  assert.deepEqual(metrics.ratio(0, 60), { reduction: null, targetMet: null });
  assert.throws(() => metrics.ratio(-1, 2));
  assert.throws(() => metrics.ratio(1, NaN));
});
test('benchmark summaries retain independent counters and summarize five real measurements', () => {
  const rows = [5, 1, 4, 2, 3].map(seconds => ({ seconds, logicalBytes: 1000, storedBytes: 100, uploadWireBytes: 200, downloadWireBytes: 250, artifactBytes: 250, verified: true }));
  const summary = metrics.summarize(rows);
  assert.equal(summary.repetitions, 5);
  assert.equal(summary.seconds.median, 3);
  assert.equal(summary.seconds.min, 1);
  assert.equal(summary.seconds.max, 5);
  assert.equal(summary.artifactBytes.median, 250);
  assert.equal(summary.uploadWireBytes.median, 200);
  assert.equal(summary.storedBytes.median, 100);
  assert.throws(() => metrics.summarize([{ ...rows[0], verified: false }]));
});
