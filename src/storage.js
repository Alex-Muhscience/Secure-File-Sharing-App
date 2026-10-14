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
  wrap(key, id, keyId = this.config.keyId) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.config.keys[keyId], iv);
    cipher.setAAD(Buffer.from(`wrap:${id}`));
    const wrapped = Buffer.concat([cipher.update(key), cipher.final()]);
    return { version: 2, keyId, wrappedKey: wrapped.toString('hex'), wrappingIv: iv.toString('hex'), wrappingTag: cipher.getAuthTag().toString('hex') };
  }
  dataKey(file) {
    if (file.version === 1) return this.config.key;
    if (file.version !== 2 || !Object.hasOwn(this.config.keys, file.keyId)) throw new Error('Unknown encryption version or key');
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.config.keys[file.keyId], Buffer.from(file.wrappingIv, 'hex'), { authTagLength: 16 });
    decipher.setAAD(Buffer.from(`wrap:${file.objectId}`));
    decipher.setAuthTag(Buffer.from(file.wrappingTag, 'hex'));
    return Buffer.concat([decipher.update(Buffer.from(file.wrappedKey, 'hex')), decipher.final()]);
  }
  rewrap(file) { return this.wrap(this.dataKey(file), file.objectId); }
  _handleFile(req, file, cb) {
    const id = crypto.randomUUID();
    const iv = crypto.randomBytes(12);
    const dataKey = crypto.randomBytes(32);
    const wrapped = this.wrap(dataKey, id);
    const cipher = crypto.createCipheriv('aes-256-gcm', dataKey, iv);
    cipher.setAAD(Buffer.from(id));
    const output = fs.createWriteStream(this.objectPath(id), { flags: 'wx', mode: 0o600 });
    const abort = () => file.stream.destroy(new Error('Upload interrupted'));
    req.once('aborted', abort);
    pipeline(file.stream, cipher, output).then(() => cb(null, {
      objectId: id, size: output.bytesWritten, iv: iv.toString('hex'),
      tag: cipher.getAuthTag().toString('hex'), ...wrapped,
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
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.dataKey(file), Buffer.from(file.iv, 'hex'), { authTagLength: 16 });
    decipher.setAAD(Buffer.from(file.objectId));
    decipher.setAuthTag(Buffer.from(file.tag, 'hex'));
    // Authenticate the entire bounded object before releasing any bytes to HTTP.
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  }
  async ready() { await fsp.access(this.config.storage, fs.constants.R_OK | fs.constants.W_OK); }
}
module.exports = { Storage };
