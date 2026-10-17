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
const { sealArchive, openArchive } = require('../src/archive');
const collections = ['organizations', 'transfers', 'audit', 'usage', 'invoices', 'orders', 'paymentEvents', 'uploads', 'chunks'];
async function main() {
  const [mode, archive, destination] = process.argv.slice(2);
  if (!['create', 'restore'].includes(mode) || !archive) throw new Error('Usage: backup.cjs create <archive> | restore <archive> <new-database>');
  if (!/^[a-f\d]{64}$/i.test(process.env.BACKUP_KEY || '')) throw new Error('BACKUP_KEY must contain 64 hex characters');
  const key = Buffer.from(process.env.BACKUP_KEY, 'hex'), config = loadConfig(), storage = new Storage(config);
  const client = new MongoClient(config.mongoUri); let partial = null;
  try {
    await client.connect();
    if (mode === 'create') {
      const db = client.db(); storage.attach(db);
      await fsp.mkdir(path.dirname(path.resolve(archive)), { recursive: true, mode: 0o700 });
      const output = fs.createWriteStream(archive, { flags: 'wx', mode: 0o600 }); partial = archive;
      async function* records() {
        yield JSON.stringify({ type: 'manifest', version: 2, createdAt: new Date().toISOString() }) + '\n';
        for (const collection of collections) for await (const record of db.collection(collection).find()) {
          yield JSON.stringify({ type: 'record', collection, record: BSON.EJSON.serialize(record) }) + '\n';
        }
        for await (const file of db.collection('transfers').find({ status: { $ne: 'deleted' } })) {
          if (file.format === 'segments-v1') continue;
          const bytes = await storage.readCiphertext(file);
          yield JSON.stringify({ type: 'object', objectId: file.objectId, bytes: bytes.toString('base64') }) + '\n';
        }
        for await (const part of db.collection('chunks').find()) {
          const bytes = await storage.readCiphertext(part);
          yield JSON.stringify({ type: 'object', objectId: part.objectId, bytes: bytes.toString('base64') }) + '\n';
        }
      }
      await pipeline(Readable.from(sealArchive(records(), key)), output);
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
      const version = header.subarray(0, 5).toString();
      if (!['STBK1', 'STBK2'].includes(version) || stat.size < 33) throw new Error('Invalid archive');
      const decipher = () => {
        const instance = crypto.createDecipheriv('aes-256-gcm', key, header.subarray(5), { authTagLength: 16 }); instance.setAuthTag(tag); return instance;
      };
      const open = () => version === 'STBK2'
        ? Readable.from(openArchive(fs.createReadStream(archive), key))
        : fs.createReadStream(archive, { start: 17, end: stat.size - 17 }).pipe(decipher());
      // Verify all authenticated archive bytes before restoring anything. Plaintext stays in memory.
      const sink = new Transform({ transform(chunk, encoding, cb) { cb(); } });
      await pipeline(open(), sink);
      await storage.init();
      for await (const object of storage.list(true)) { throw new Error('Restore storage destination must be empty'); }
      const plaintext = open();
      const lines = readline.createInterface({ input: plaintext, crlfDelay: Infinity });
      for await (const line of lines) {
        const entry = JSON.parse(line);
        if (entry.type === 'record') {
          if (!collections.includes(entry.collection)) throw new Error('Invalid backup collection');
          const record = BSON.EJSON.deserialize(entry.record);
          if (['transfers', 'chunks'].includes(entry.collection)) { record.storageBackend = storage.driver; delete record.retainedBackends; }
          await db.collection(entry.collection).insertOne(record);
        } else if (entry.type === 'object') {
          await storage.importCiphertext(entry.objectId, Buffer.from(entry.bytes, 'base64'));
        } else if (entry.type !== 'manifest' || ![1, 2].includes(entry.version)) throw new Error('Invalid backup manifest');
      }
      await initialize(db);
      storage.attach(db);
      for await (const file of db.collection('transfers').find({ status: { $ne: 'deleted' } })) await storage.verify(file);
      for await (const part of db.collection('chunks').find()) await storage.verify(part);
      console.log(`Restore verified in ${destination}; sessions were deliberately excluded.`);
    }
  } finally { storage.close(); await client.close(); if (partial) await fsp.rm(partial, { force: true }); }
}
main().catch(error => { console.error('Backup operation failed:', error.message); process.exitCode = 1; });
