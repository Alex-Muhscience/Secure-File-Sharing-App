const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { MongoClient } = require('mongodb');
const { loadConfig } = require('../src/config');
const { Storage } = require('../src/storage');
const { initialize } = require('../src/database');
const { createApp } = require('../src/app');
async function main() {
  const size = Number(process.env.BENCHMARK_BYTES || 128 * 1024 * 1024), chunkSize = 8 * 1024 * 1024;
  if (!Number.isSafeInteger(size) || size < 64 * 1024 * 1024 || size > 4 * 1024 ** 3 || size % chunkSize) throw new Error('BENCHMARK_BYTES must be 64 MiB–4 GiB in multiples of 8 MiB');
  const directory = await fs.mkdtemp(path.join(process.env.BENCHMARK_ROOT || os.tmpdir(), 'transfer-benchmark-')), client = new MongoClient(process.env.TEST_MONGO_URI || 'mongodb://mongo:27017');
  const db = client.db(`benchmark_${crypto.randomBytes(8).toString('hex')}`); let server, storage, sampler;
  const rssStart = process.memoryUsage().rss; let peakRss = rssStart;
  const sample = () => { peakRss = Math.max(peakRss, process.memoryUsage().rss); };
  try {
    await client.connect(); await initialize(db);
    const config = { ...loadConfig({ ENCRYPTION_KEY: '12'.repeat(32), OTP_SECRET: '34'.repeat(32), MONGO_URI: 'mongodb://mongo/test', SMTP_HOST: 'mail', MAX_FILE_SIZE: String(size) }), storage: path.join(directory, 'objects'), scanMaxSize: size };
    storage = new Storage(config); await storage.init();
    const running = createApp({ config, db, storage, mail: { async sendMail() {} }, scanner: { async scanStream(source) { let inspected = 0; for await (const chunk of source) inspected += chunk.length; assert.equal(inspected, size); return { clean: true }; } } });
    server = running.app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    const token = crypto.randomBytes(32).toString('hex'), identity = 'benchmark@example.com';
    await db.collection('sessions').insertOne({ _id: crypto.createHash('sha256').update(token).digest('hex'), email: identity, expiresAt: new Date(Date.now() + 3600000) });
    const org = await running.pilot.createTeam(identity, 'Synthetic transfer benchmark'); await db.collection('organizations').updateOne({ _id: org._id }, { $set: { plan: 'enterprise' } });
    const base = `http://127.0.0.1:${server.address().port}`, headers = { Authorization: `Bearer ${token}`, 'X-Organization-ID': org._id };
    const post = async (url, body) => { const response = await fetch(base + url, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); assert.ok(response.ok, await response.clone().text()); return response.json(); };
    sampler = setInterval(sample, 5); const started = performance.now();
    const upload = await post('/api/uploads', { name: 'synthetic-mixed.bin', size, fingerprint: crypto.randomBytes(32).toString('hex'), recipient: identity, expiryHours: 24, compression: 'auto' });
    const original = crypto.createHash('sha256');
    for (let offset = 0; offset < size; offset += chunkSize) {
      const chunk = Buffer.alloc(chunkSize, 65); crypto.randomFillSync(chunk.subarray(0, chunkSize / 4)); original.update(chunk);
      const response = await fetch(`${base}/api/uploads/${upload.uploadId}/chunks`, { method: 'PUT', headers: { ...headers, 'Content-Type': 'application/octet-stream', 'Upload-Offset': String(offset), 'X-Chunk-SHA256': crypto.createHash('sha256').update(chunk).digest('hex') }, body: chunk });
      assert.ok(response.ok, `Part at ${offset}: ${await response.clone().text()}`); await response.arrayBuffer(); sample();
    }
    const completed = await post(`/api/uploads/${upload.uploadId}/complete`, {}), uploadedAt = performance.now();
    await running.worker.tick(); const scannedAt = performance.now();
    const response = await fetch(`${base}/api/file/${completed.fileId}/download`, { headers }); assert.equal(response.status, 200);
    const downloaded = crypto.createHash('sha256'); let received = 0;
    for await (const chunk of response.body) { downloaded.update(chunk); received += chunk.length; sample(); }
    assert.equal(received, size); assert.equal(downloaded.digest('hex'), original.digest('hex')); sample();
    assert.ok(peakRss < 450 * 1024 * 1024, `Peak RSS ${Math.round(peakRss / 1024 ** 2)} MiB exceeded the pilot budget`);
    console.log(JSON.stringify({ runtime: process.version, storage: 'filesystem', fixture: 'Each 8 MiB part contains 25% independent random bytes and 75% repeated A bytes', scanner: 'Counting fixture; not a malware-scanner benchmark', logicalBytes: size, storedBytes: completed.storedSize, compressionReductionPercent: Number((100 * (1 - completed.storedSize / size)).toFixed(3)), chunkBytes: chunkSize, uploadSeconds: Number(((uploadedAt - started) / 1000).toFixed(2)), verificationSeconds: Number(((scannedAt - uploadedAt) / 1000).toFixed(2)), downloadSeconds: Number(((performance.now() - scannedAt) / 1000).toFixed(2)), peakRssMiB: Number((peakRss / 1024 ** 2).toFixed(1)), sha256Match: true }, null, 2));
  } finally {
    clearInterval(sampler); if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    storage?.close(); await db.dropDatabase().catch(() => {}); await client.close(); await fs.rm(directory, { recursive: true, force: true });
  }
}
main().catch(error => { console.error('Large-file benchmark failed:', error.message); process.exitCode = 1; });
