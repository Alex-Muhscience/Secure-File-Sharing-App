const {test}=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('node:crypto');
const {benchmarkFixture}=require('../scripts/benchmark-codecs.cjs');
test('codec comparison reports all candidates including losses and counts actual archive overhead',async()=>{
  const bytes=crypto.randomBytes(256),result=await benchmarkFixture({name:'random.bin',bytes,category:'archives',source:'test',holdout:true},1);
  assert.equal(result.cases.length,8);
  assert.ok(result.cases.every(row=>row.verified));
  const custom=result.cases.find(row=>row.codec==='stp1');
  assert.ok(custom.artifactBytes>custom.payloadBytes);
  assert.ok(custom.artifactBytes>bytes.length);
  assert.equal(custom.targetMet,false);
  assert.equal(result.originalBytes,bytes.length);
  assert.equal(result.sha256,crypto.createHash('sha256').update(bytes).digest('hex'));
});
