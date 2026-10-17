const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { Scanner } = require('../src/scanner');
test('external scanner streams with backpressure and requires a complete inspection result', async t => {
  let mode = 'clean', receivedHash;
  const server = http.createServer((req, res) => {
    const hash = crypto.createHash('sha256'); let bytes = 0;
    req.on('data', chunk => { hash.update(chunk); bytes += chunk.length; });
    req.on('end', () => { receivedHash = hash.digest('hex'); res.writeHead(mode === 'failure' ? 503 : 200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ clean: mode !== 'infected', scannedBytes: mode === 'partial' ? bytes - 1 : bytes })); });
  });
  server.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const scanner = new Scanner({ scannerMode: 'http', scannerHttpUrl: 'https://scanner.example.com/scan', scannerHttpToken: 'fixture-token-for-private-scanner', scanMaxSize: 1024 * 1024 }, {
    httpsRequest: (url, options, callback) => http.request({ hostname: '127.0.0.1', port: server.address().port, path: url.pathname, ...options }, callback),
  });
  const plain = crypto.randomBytes(256 * 1024);
  assert.deepEqual(await scanner.scanStream(Readable.from([plain]), { size: plain.length }), { clean: true });
  assert.equal(receivedHash, crypto.createHash('sha256').update(plain).digest('hex'));
  mode = 'partial'; await assert.rejects(scanner.scanStream(Readable.from([plain]), { size: plain.length }), /scan|inspect|bytes/i);
  mode = 'infected'; assert.equal((await scanner.scanStream(Readable.from([plain]), { size: plain.length })).clean, false);
  mode = 'failure'; await assert.rejects(scanner.scanStream(Readable.from([plain]), { size: plain.length }));
  mode = 'clean'; await assert.rejects(scanner.scanStream(Readable.from([plain]), { size: plain.length - 1 }));
});
