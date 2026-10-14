const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
class Storage {
  constructor(config) { this.config = config; }
  objectPath(id) {
    if (!/^[a-f\d-]{36}$/.test(id)) throw new Error('Invalid object identifier');
    return path.join(this.config.storage, `${id}.enc`);
  }
  async init() { await fsp.mkdir(this.config.storage, { recursive: true, mode: 0o700 }); }
  _handleFile(req, file, cb) {
    const id = crypto.randomUUID();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.config.key, iv);
    cipher.setAAD(Buffer.from(id));
    const output = fs.createWriteStream(this.objectPath(id), { flags: 'wx', mode: 0o600 });
    const abort = () => file.stream.destroy(new Error('Upload interrupted'));
    req.once('aborted', abort);
    pipeline(file.stream, cipher, output).then(() => cb(null, {
      objectId: id, size: output.bytesWritten, iv: iv.toString('hex'),
      tag: cipher.getAuthTag().toString('hex'), version: 1,
    })).catch(async error => {
      await this.remove(id).catch(() => {}); cb(error);
    }).finally(() => req.removeListener('aborted', abort));
  }
  _removeFile(req, file, cb) { this.remove(file.objectId).then(() => cb(null), cb); }
  async remove(id) { await fsp.rm(this.objectPath(id), { force: true }); }
  async decrypt(file) {
    const handle = await fsp.open(this.objectPath(file.objectId), 'r');
    let ciphertext;
    try {
      const stat = await handle.stat();
      if (stat.size > this.config.maxSize) throw new Error('Object exceeds size limit');
      ciphertext = Buffer.alloc(stat.size);
      const result = await handle.read(ciphertext, 0, ciphertext.length, 0);
      if (result.bytesRead !== ciphertext.length) throw new Error('Incomplete object');
    } finally { await handle.close(); }
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.config.key, Buffer.from(file.iv, 'hex'), { authTagLength: 16 });
    decipher.setAAD(Buffer.from(file.objectId));
    decipher.setAuthTag(Buffer.from(file.tag, 'hex'));
    // Authenticate the entire bounded object before releasing any bytes to HTTP.
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  }
  async ready() { await fsp.access(this.config.storage, fs.constants.R_OK | fs.constants.W_OK); }
}
module.exports = { Storage };
