const crypto = require('node:crypto');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { FileStore, S3Store } = require('./object-store');
class Storage {
  constructor(config) {
    this.config = config; this.driver = config.storageDriver || 'filesystem';
    this.requiredBackends = new Set([this.driver]);
    this.stores = { filesystem: new FileStore(config.storage) };
    if (config.s3) this.stores.s3 = new S3Store(config.s3);
  }
  store(backend = this.driver) {
    if (!Object.hasOwn(this.stores, backend)) throw new Error('Object backend is not configured');
    return this.stores[backend];
  }
  objectPath(id) { return this.stores.filesystem.objectPath(id); }
  async init() { await this.stores.filesystem.init(); if (this.driver !== 'filesystem') await this.store().init(); }
  async ready() { for (const backend of this.requiredBackends) await this.store(backend).ready(); }
  async checkReferences(db) {
    const transfers = db.collection('transfers'), filter = { status: { $ne: 'deleted' } };
    const [primary, retained] = await Promise.all([transfers.distinct('storageBackend', filter), transfers.distinct('retainedBackends', filter)]);
    const legacy = await transfers.findOne({ ...filter, storageBackend: { $exists: false } }, { projection: { _id: 1 } });
    this.requiredBackends = new Set([this.driver, ...primary, ...retained, ...(legacy ? ['filesystem'] : [])]);
    await this.ready();
  }
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
    const id = crypto.randomUUID(), iv = crypto.randomBytes(12), key = crypto.randomBytes(32), controller = new AbortController();
    const wrapped = this.wrap(key, id), cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(id));
    let size = 0;
    const measured = new Transform({ transform: (chunk, encoding, done) => {
      size += chunk.length;
      done(size > this.config.maxSize ? new Error('Object exceeds size limit') : null, chunk);
    } });
    const abort = () => controller.abort(); req.once('aborted', abort);
    const fail = error => { controller.abort(); throw error; };
    const jobs = [pipeline(file.stream, cipher, measured, { signal: controller.signal }).catch(fail), this.store().write(id, measured, controller).catch(fail)];
    Promise.allSettled(jobs).then(async results => {
      const failure = results.find(result => result.status === 'rejected');
      if (failure) { await this.remove(id).catch(() => {}); cb(failure.reason); }
      else cb(null, { objectId: id, storageBackend: this.driver, size, iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), ...wrapped });
    }).catch(cb).finally(() => req.removeListener('aborted', abort));
  }
  _removeFile(req, file, cb) { this.remove(file.objectId, file.storageBackend).then(() => cb(null), cb); }
  async remove(id, backend = this.driver) { await this.store(backend).remove(id); }
  async removeRecord(file) {
    for (const backend of new Set([file.storageBackend || 'filesystem', ...(file.retainedBackends || [])])) await this.remove(file.objectId, backend);
  }
  async readCiphertext(file) { return this.store(file.storageBackend || 'filesystem').read(file.objectId, this.config.maxSize); }
  authenticate(file, ciphertext) {
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.dataKey(file), Buffer.from(file.iv, 'hex'), { authTagLength: 16 });
    decipher.setAAD(Buffer.from(file.objectId)); decipher.setAuthTag(Buffer.from(file.tag, 'hex'));
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  }
  async decrypt(file) { return this.authenticate(file, await this.readCiphertext(file)); }
  async importCiphertext(id, bytes, backend = this.driver) {
    if (bytes.length > this.config.maxSize) throw new Error('Object exceeds size limit');
    const controller = new AbortController(); await this.store(backend).write(id, Readable.from(bytes), controller);
  }
  async *list(primaryOnly = false) {
    for (const store of primaryOnly ? [this.store()] : Object.values(this.stores)) yield* store.list();
  }
  async cleanupMultipart(before) { if (this.stores.s3) await this.stores.s3.cleanupMultipart(before); }
  close() { for (const store of Object.values(this.stores)) store.close(); }
}
module.exports = { Storage };
