const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const readline = require('node:readline');
const { MongoClient, BSON } = require('mongodb');
const { loadConfig } = require('../src/config');
const { Storage } = require('../src/storage');
const { initialize } = require('../src/database');
const collections = ['organizations', 'transfers', 'audit', 'usage'];
async function main() {
  const [mode, archive, destination] = process.argv.slice(2);
  if (!['create', 'restore'].includes(mode) || !archive) throw new Error('Usage: backup.cjs create <archive> | restore <archive> <new-database>');
  if (!/^[a-f\d]{64}$/i.test(process.env.BACKUP_KEY || '')) throw new Error('BACKUP_KEY must contain 64 hex characters');
  const key = Buffer.from(process.env.BACKUP_KEY, 'hex'), config = loadConfig(), storage = new Storage(config);
  const client = new MongoClient(config.mongoUri); let partial = null;
  try {
    await client.connect();
    if (mode === 'create') {
      const db = client.db(), iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
      await fsp.mkdir(path.dirname(path.resolve(archive)), { recursive: true, mode: 0o700 });
      const output = fs.createWriteStream(archive, { flags: 'wx', mode: 0o600 }); partial = archive;
      output.write(Buffer.concat([Buffer.from('STBK1'), iv]));
      async function* records() {
        yield JSON.stringify({ type: 'manifest', version: 1, createdAt: new Date().toISOString() }) + '\n';
        for (const collection of collections) for await (const record of db.collection(collection).find()) {
          yield JSON.stringify({ type: 'record', collection, record: BSON.EJSON.serialize(record) }) + '\n';
        }
        for await (const file of db.collection('transfers').find({ status: { $ne: 'deleted' } })) {
          const bytes = await storage.readCiphertext(file);
          yield JSON.stringify({ type: 'object', objectId: file.objectId, bytes: bytes.toString('base64') }) + '\n';
        }
      }
      const appendTag = new Transform({ transform(chunk, encoding, cb) { cb(null, chunk); }, flush(cb) { this.push(cipher.getAuthTag()); cb(); } });
      await pipeline(Readable.from(records()), cipher, appendTag, output);
      if (process.env.BACKUP_OWNER_UID || process.env.BACKUP_OWNER_GID) {
        if (!/^\d+$/.test(process.env.BACKUP_OWNER_UID || '') || !/^\d+$/.test(process.env.BACKUP_OWNER_GID || '')) throw new Error('Invalid archive owner');
        await fsp.chown(archive, Number(process.env.BACKUP_OWNER_UID), Number(process.env.BACKUP_OWNER_GID));
      }
      partial = null; console.log(`Encrypted backup created at ${archive}`);
    } else {
      if (!destination || !/^restore_[a-z\d_]{1,60}$/i.test(destination)) throw new Error('Restore destination must be a new restore_* database');
      const db = client.db(destination);
      if ((await db.listCollections().toArray()).length) throw new Error('Restore database must be empty');
      const handle = await fsp.open(archive, 'r'); let stat, header, tag;
      try {
        stat = await handle.stat(); header = Buffer.alloc(17); tag = Buffer.alloc(16);
        await handle.read(header, 0, 17, 0); await handle.read(tag, 0, 16, stat.size - 16);
      } finally { await handle.close(); }
      if (header.subarray(0, 5).toString() !== 'STBK1' || stat.size < 33) throw new Error('Invalid archive');
      const decipher = () => {
        const instance = crypto.createDecipheriv('aes-256-gcm', key, header.subarray(5), { authTagLength: 16 }); instance.setAuthTag(tag); return instance;
      };
      // Verify all authenticated archive bytes before restoring anything. Plaintext stays in memory.
      const sink = new Transform({ transform(chunk, encoding, cb) { cb(); } });
      await pipeline(fs.createReadStream(archive, { start: 17, end: stat.size - 17 }), decipher(), sink);
      await storage.init();
      for await (const object of storage.list(true)) { throw new Error('Restore storage destination must be empty'); }
      const plaintext = fs.createReadStream(archive, { start: 17, end: stat.size - 17 }).pipe(decipher());
      const lines = readline.createInterface({ input: plaintext, crlfDelay: Infinity });
      for await (const line of lines) {
        const entry = JSON.parse(line);
        if (entry.type === 'record') {
          if (!collections.includes(entry.collection)) throw new Error('Invalid backup collection');
          const record = BSON.EJSON.deserialize(entry.record);
          if (entry.collection === 'transfers') { record.storageBackend = storage.driver; delete record.retainedBackends; }
          await db.collection(entry.collection).insertOne(record);
        } else if (entry.type === 'object') {
          await storage.importCiphertext(entry.objectId, Buffer.from(entry.bytes, 'base64'));
        } else if (entry.type !== 'manifest' || entry.version !== 1) throw new Error('Invalid backup manifest');
      }
      await initialize(db);
      for await (const file of db.collection('transfers').find({ status: { $ne: 'deleted' } })) await storage.decrypt(file);
      console.log(`Restore verified in ${destination}; sessions were deliberately excluded.`);
    }
  } finally { storage.close(); await client.close(); if (partial) await fsp.rm(partial, { force: true }); }
}
main().catch(error => { console.error('Backup operation failed:', error.message); process.exitCode = 1; });
