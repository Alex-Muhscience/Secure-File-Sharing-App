const net = require('node:net');
const { Readable } = require('node:stream');
const https = require('node:https');
const { pipeline } = require('node:stream/promises');
class Scanner {
  constructor(config, dependencies = {}) { this.config = config; this.httpsRequest = dependencies.httpsRequest || https.request; }
  async scan(bytes) { return this.scanStream(Readable.from([bytes]), { size: bytes.length }); }
  async scanHttp(source, info) {
    const { size } = info;
    if (!Number.isSafeInteger(size) || size < 0 || size > this.config.scanMaxSize) throw new Error('Invalid scanner size limit');
    let request, sent = 0;
    const answer = new Promise((resolve, reject) => {
      request = this.httpsRequest(new URL(this.config.scannerHttpUrl), { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(size), Authorization: `Bearer ${this.config.scannerHttpToken}`, ...(info.fileId ? { 'X-File-ID': info.fileId } : {}) } }, response => {
        (async () => {
          const chunks = []; let length = 0;
          for await (const chunk of response) { length += chunk.length; if (length > 4096) throw new Error('Invalid scanner response'); chunks.push(Buffer.from(chunk)); }
          if (response.statusCode !== 200) throw new Error('Scanner could not inspect the file');
          const result = JSON.parse(Buffer.concat(chunks).toString());
          if (typeof result.clean !== 'boolean' || result.scannedBytes !== size) throw new Error('Scanner did not confirm inspection of all bytes');
          return { clean: result.clean, ...(!result.clean && typeof result.signature === 'string' ? { signature: result.signature.slice(0, 120) } : {}) };
        })().then(resolve, reject);
      });
      request.once('error', reject);
      request.setTimeout(this.config.scannerIdleTimeout || 30000, () => request.destroy(new Error('Scanner timeout')));
    });
    async function* measured() { for await (const bytes of source) { sent += bytes.length; if (sent > size) throw new Error('Scanner stream exceeds expected bytes'); yield bytes; } if (sent !== size) throw new Error('Incomplete scanner stream'); }
    try { const results = await Promise.all([pipeline(Readable.from(measured()), request), answer]); return results[1]; }
    catch (error) { request.destroy(); throw error; }
  }
  async scanStream(source, info = {}) {
    if (this.config.scannerMode === 'http') return this.scanHttp(source, info);
    if (!this.config.scannerHost) throw new Error('Malware scanner is not configured');
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: this.config.scannerHost, port: this.config.scannerPort });
      let response = '', settled = false;
      const done = (error, result) => {
        if (settled) return; settled = true; socket.destroy(); error ? reject(error) : resolve(result);
      };
      socket.setTimeout(30000, () => done(new Error('Scanner timeout')));
      socket.on('error', error => done(error));
      socket.on('connect', () => {
        const write = bytes => new Promise((resolve, reject) => socket.write(bytes, error => error ? reject(error) : resolve()));
        (async () => {
          await write('zINSTREAM\0');
          for await (const bytes of source) {
            for (let offset = 0; offset < bytes.length; offset += 65536) {
              if (settled) return;
              const chunk = bytes.subarray(offset, offset + 65536), size = Buffer.alloc(4); size.writeUInt32BE(chunk.length);
              await write(size); await write(chunk);
            }
          }
          if (!settled) await write(Buffer.alloc(4));
        })().catch(error => done(error));
      });
      socket.on('data', chunk => {
        response += chunk.toString();
        if (response.length > 4096) return done(new Error('Invalid scanner response'));
        if (!response.includes('\0') && !response.includes('\n')) return;
        const reply = response.replace(/[\0\r\n]/g, '');
        if (reply === 'stream: OK') done(null, { clean: true });
        else if (/^stream: .+ FOUND$/.test(reply)) done(null, { clean: false, signature: reply.slice(8, -6) });
        else done(new Error('Scanner could not inspect the file'));
      });
      socket.on('end', () => { if (!settled) done(new Error('Incomplete scanner response')); });
    });
  }
}
module.exports = { Scanner };
