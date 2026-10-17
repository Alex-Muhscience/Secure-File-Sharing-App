const http = require('node:http');
const { Transform } = require('node:stream');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { MongoClient } = require('mongodb');
const { corpus, manifest, hash } = require('./benchmark-corpus.cjs');
const { summarize } = require('../src/benchmark-metrics');
const args = process.argv.slice(2);
const option = (name, fallback) => { const i = args.indexOf(`--${name}`); return i < 0 ? fallback : args[i + 1]; };
const profiles = { wan: { up: 10e6 / 8, down: 50e6 / 8, latency: 80 }, lan: { up: 1e9 / 8, down: 1e9 / 8, latency: 2 } };
const delay = ms => new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
async function listen(server) { server.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve)); return `http://127.0.0.1:${server.address().port}`; }
function shaper(rate) {
  let next = 0;
  return () => new Transform({ transform(bytes, encoding, callback) {
    next = Math.max(next, performance.now()) + bytes.length * 1000 / rate;
    setTimeout(() => callback(null, bytes), Math.max(0, next - performance.now()));
  } });
}
async function measure(fixture, profile, clients, repetitions, mode, interrupted) {
  const wireMode=option('wire',mode==='baseline'?'none':'gzip'),downloadFormat=option('download',mode==='baseline'?'original':'stc'),storageMode=option('compression',mode==='baseline'?'auto':'adaptive');
  if(!['none','gzip'].includes(wireMode)||!['original','stc'].includes(downloadFormat)||!['auto','adaptive','research','smallest','none'].includes(storageMode))throw new Error('Invalid benchmark variant');
  const root = path.resolve(option('app-root', path.join(__dirname, '..')));
  const { createApp } = require(path.join(root, 'src/app'));
  const { Storage } = require(path.join(root, 'src/storage'));
  const { initialize } = require(path.join(root, 'src/database'));
  const { loadConfig } = require(path.join(root, 'src/config'));
  const { Scanner } = require(path.join(root, 'src/scanner'));
  const client = new MongoClient(process.env.TEST_MONGO_URI || 'mongodb://mongo:27017');
  const db = client.db(`perf_${crypto.randomBytes(8).toString('hex')}`);
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'transfer-perf-'));
  let server, proxy, storage, sampler;
  let peakRss = process.memoryUsage().rss;
  const cpuStart = process.cpuUsage();
  const config = { ...loadConfig({ ENCRYPTION_KEY: '12'.repeat(32), OTP_SECRET: '34'.repeat(32), MONGO_URI: 'mongodb://mongo/test', SMTP_HOST: 'mail', SCANNER_HOST: 'scanner' }), storage: directory };
  try {
    await client.connect(); await initialize(db);
    storage = new Storage(config); await storage.init();
    const scanner = option('scanner', 'clamav') === 'counting' ? { async scanStream(source) { for await (const bytes of source) {} return { clean: true }; } } : new Scanner(config);
    const running = createApp({ config, db, storage, scanner, mail: { async sendMail() {} } });
    server = http.createServer(running.app); const backend = await listen(server);
    const upstream = shaper(profile.up), downstream = shaper(profile.down);
    proxy = http.createServer(async (req, res) => {
      await delay(profile.latency);
      const forwarded = http.request(backend + req.url, { method: req.method, headers: req.headers }, response => {
        res.writeHead(response.statusCode, response.headers);
        response.pipe(downstream()).pipe(res);
        response.on('error', () => res.destroy());
      });
      req.pipe(upstream()).pipe(forwarded);
      forwarded.on('error', () => res.destroy());
      res.on('close', () => { if (!res.writableFinished) forwarded.destroy(); });
    });
    const base = await listen(proxy), identities = [];
    for (let i = 0; i < clients; i++) {
      const identity = `performance-${i}@example.com`, token = crypto.randomBytes(32).toString('hex');
      await db.collection('sessions').insertOne({ _id: hash(token), email: identity, expiresAt: new Date(Date.now() + 3600000) });
      const org = await running.pilot.createTeam(identity, 'Disposable performance fixture');
      await db.collection('organizations').updateOne({ _id: org._id }, { $set: { plan: 'enterprise' } });
      identities.push({ identity, headers: { Authorization: `Bearer ${token}`, 'X-Organization-ID': org._id } });
    }
    const rows = [];
    sampler = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 5);
    for (let repeat = 0; repeat < repetitions; repeat++) {
      const batch = await Promise.all(identities.map(async ({ identity, headers }) => {
        const started = performance.now(); let encodeMs = 0, uploadWireBytes = 0;
        const post = async (url, body) => { const r = await fetch(base + url, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); assert.equal(r.ok, true, await r.clone().text()); return r.json(); };
        const settings = { name: fixture.name, size: fixture.bytes.length, recipient: identity, fingerprint: crypto.randomBytes(32).toString('hex'), compression: storageMode };
        const upload = await post('/api/uploads', settings);
        for (let offset = 0; offset < fixture.bytes.length; offset += upload.chunkSize) {
          const plain = fixture.bytes.subarray(offset, offset + upload.chunkSize);
          const before = performance.now(); let body = plain, codec = 'none';
          if (wireMode === 'gzip') {
            const gzip = require('node:util').promisify(require('node:zlib').gzip);
            const compressed = await gzip(plain, { level: 1 });
            if (compressed.length < plain.length * .98) { body = compressed; codec = 'gzip'; }
          }
          encodeMs += performance.now() - before; uploadWireBytes += body.length;
          const response = await fetch(`${base}/api/uploads/${upload.uploadId}/chunks`, { method: 'PUT', headers: { ...headers, 'Content-Type': 'application/octet-stream', 'Upload-Offset': String(offset), 'X-Chunk-SHA256': hash(plain), ...(mode !== 'baseline' ? { 'X-Chunk-Codec': codec, 'X-Chunk-Logical-Length': String(plain.length) } : {}) }, body });
          assert.equal(response.status, 200, await response.clone().text()); await response.arrayBuffer();
          if (interrupted) {
            const resumed = await post('/api/uploads', { ...settings, resumeId: upload.uploadId });
            assert.equal(resumed.offset, offset + plain.length);
          }
        }
        const completed = await post(`/api/uploads/${upload.uploadId}/complete`, {});
        return { started, uploaded: performance.now(), encodeMs, uploadWireBytes, completed, headers };
      }));
      await running.worker.tick();
      const ready = performance.now();
      const measured = await Promise.all(batch.map(async row => {
        const suffix = downloadFormat === 'original' ? 'download' : 'export/stc';
        const response = await fetch(`${base}/api/file/${row.completed.fileId}/${suffix}`, { headers: row.headers });
        assert.equal(response.status, 200, await response.clone().text());
        let firstByteMs = null, downloadWireBytes = 0; const chunks = [];
        const downloadStart = performance.now();
        for await (const bytes of response.body) { firstByteMs ??= performance.now() - ready; downloadWireBytes += bytes.length; chunks.push(Buffer.from(bytes)); }
        const downloaded = performance.now(); let bytes = Buffer.concat(chunks);
        if (downloadFormat !== 'original') {
          const { restore } = require(path.join(root, 'src/compressed-archive'));
          const opened = await restore([bytes], { maxOutputBytes: config.maxSize });
          const plain = []; for await (const part of opened.stream) plain.push(part); bytes = Buffer.concat(plain);
        }
        assert.equal(hash(bytes), fixture.sha256); assert.equal(bytes.length, fixture.bytes.length);
        return { seconds: (performance.now() - row.started) / 1000, encodeMs: row.encodeMs, uploadSeconds: (row.uploaded - row.started) / 1000, readySeconds: (ready - row.started) / 1000, firstByteMs: firstByteMs || 0, downloadSeconds: (downloaded - downloadStart) / 1000, restoreMs: performance.now() - downloaded, logicalBytes: fixture.bytes.length, storedBytes: row.completed.storedSize, uploadWireBytes: row.uploadWireBytes, downloadWireBytes, ...(downloadFormat !== 'original' ? { artifactBytes: downloadWireBytes } : {}), peakRssBytes: Math.max(peakRss, process.memoryUsage().rss), verified: true };
      }));
      rows.push(...measured);
    }
    const cpu = process.cpuUsage(cpuStart);
    return { fixture: fixture.name, sha256: fixture.sha256, mode, wireMode,downloadFormat,storageMode, clients, batches:repetitions, interrupted, profile, scanner: option('scanner', 'clamav'), sourceVersion: require(path.join(root, 'package.json')).version, revision: option('revision', 'unrecorded working tree'), cpuMilliseconds: (cpu.user + cpu.system) / 1000, client:'Node gzip level 1; browser worker behavior verified separately, browser encode time not measured here',networkAccounting: 'File-chunk and attachment HTTP body bytes only; excludes API metadata and HTTP/TCP/TLS overhead. Shared application-stream shaping, not a TCP congestion simulation.', summary: summarize(rows), rows };
  } finally {
    clearInterval(sampler);
    for (const instance of [proxy, server]) if (instance) { instance.closeAllConnections(); await new Promise(resolve => instance.close(resolve)); }
    storage?.close(); await db.dropDatabase().catch(() => {}); await client.close(); await fs.rm(directory, { recursive: true, force: true });
  }
}
async function main() {
  const profile = profiles[option('profile', 'wan')]; if (!profile) throw new Error('Use --profile wan|lan');
  const repetitions = Number(option('repetitions', 5)), clients = Number(option('clients', 1));
  if (![1, 4].includes(clients) || !Number.isInteger(repetitions) || repetitions < 1 || repetitions > 5) throw new Error('Use 1/4 clients and 1–5 repetitions');
  const selected = corpus().filter(row => option('file', 'business-records.txt') === 'all' || row.name === option('file', 'business-records.txt'));
  if (!selected.length) throw new Error('Unknown fixture');
  const results = [];
  for (const fixture of selected) {
    if (args.includes('--matrix')) {
      for (const link of Object.values(profiles)) for (const count of [1, 4]) for (const resume of [false, true]) results.push(await measure(fixture, link, count, repetitions, option('mode', 'baseline'), resume));
    } else results.push(await measure(fixture, profile, clients, repetitions, option('mode', 'baseline'), args.includes('--resume')));
  }
  console.log(JSON.stringify({ version: 1, measuredAt:new Date().toISOString(),runtime:process.version,corpus: manifest(), results }, null, 2));
}
if (require.main === module) main().catch(error => { console.error('Transfer benchmark failed:', error.message); process.exitCode = 1; });
module.exports = { measure, profiles };
