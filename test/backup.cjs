const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { EventEmitter } = require('node:events');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { MongoClient, BSON } = require('mongodb');
const { loadConfig } = require('../src/config');
const { Storage } = require('../src/storage');
const execute = promisify(execFile);
test('encrypted backup restore preserves metadata and bytes, excludes sessions and rejects corrupt archives', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'backup-'));
  const uri = process.env.TEST_MONGO_URI || 'mongodb://mongo:27017';
  const client = new MongoClient(uri), name = `backup_${crypto.randomBytes(6).toString('hex')}`, restored = `restore_${name}`, legacyDb = `restore_legacy_${name}`, corruptDb = `restore_bad_${name}`;
  t.after(async () => { await client.db(name).dropDatabase(); await client.db(restored).dropDatabase(); await client.db(legacyDb).dropDatabase(); await client.db(corruptDb).dropDatabase(); await client.close(); await fs.rm(directory, { recursive: true, force: true }); });
  await client.connect(); const db = client.db(name), source = path.join(directory, 'source'), target = path.join(directory, 'restored');
  const env = { ...process.env, STORAGE_DRIVER: 'filesystem', S3_ENDPOINT: '', ENCRYPTION_KEY: '12'.repeat(32), OTP_SECRET: '34'.repeat(32), BACKUP_KEY: '56'.repeat(32), SMTP_HOST: 'mail', STORAGE_DIR: source };
  const sourceUri = new URL(uri); sourceUri.pathname = `/${name}`; env.MONGO_URI = sourceUri.toString();
  const config = loadConfig(env), storage = new Storage(config); await storage.init();
  const bytes = crypto.randomBytes(65536);
  const file = await new Promise((resolve, reject) => storage._handleFile(new EventEmitter(), { stream: Readable.from(bytes) }, (error, value) => error ? reject(error) : resolve(value)));
  const id = crypto.randomUUID(); await db.collection('transfers').insertOne({ _id: id, ...file, status: 'active', createdAt: new Date() });
  await db.collection('sessions').insertOne({ _id: 'session-secret' });
  await db.collection('organizations').insertOne({ _id: 'tenant', name: 'Tenant', usedBytes: bytes.length });
  const archive = path.join(directory, 'backup.enc'), script = path.join(__dirname, '../scripts/backup.cjs');
  await execute(process.execPath, [script, 'create', archive], { env });
  const encrypted = await fs.readFile(archive); assert.ok(!encrypted.includes(Buffer.from('session-secret'))); assert.ok(!encrypted.includes(Buffer.from('Tenant')));
  await execute(process.execPath, [script, 'restore', archive, restored], { env: { ...env, STORAGE_DIR: target } });
  const restoredFile = await client.db(restored).collection('transfers').findOne({ _id: id });
  assert.ok(restoredFile.createdAt instanceof Date);
  const restoredStorage = new Storage({ ...config, storage: target }); assert.deepEqual(await restoredStorage.decrypt(restoredFile), bytes);
  assert.equal(await client.db(restored).collection('sessions').countDocuments(), 0);
  // Build the previously released STBK1 format independently of the new writer.
  const legacyPlain = [
    { type: 'manifest', version: 1 },
    { type: 'record', collection: 'transfers', record: BSON.EJSON.serialize(await db.collection('transfers').findOne({ _id: id })) },
    { type: 'object', objectId: file.objectId, bytes: (await storage.readCiphertext(file)).toString('base64') },
  ].map(record => JSON.stringify(record)).join('\n') + '\n';
  const legacyIv = crypto.randomBytes(12), legacyCipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(env.BACKUP_KEY, 'hex'), legacyIv);
  const legacyArchive = path.join(directory, 'legacy.enc');
  await fs.writeFile(legacyArchive, Buffer.concat([Buffer.from('STBK1'), legacyIv, legacyCipher.update(legacyPlain), legacyCipher.final(), legacyCipher.getAuthTag()]));
  const legacyDirectory = path.join(directory, 'legacy');
  await execute(process.execPath, [script, 'restore', legacyArchive, legacyDb], { env: { ...env, STORAGE_DIR: legacyDirectory } });
  const legacyStorage = new Storage({ ...config, storage: legacyDirectory });
  assert.deepEqual(await legacyStorage.decrypt(await client.db(legacyDb).collection('transfers').findOne({ _id: id })), bytes);
  await assert.rejects(execute(process.execPath, [script, 'restore', archive, restored], { env: { ...env, STORAGE_DIR: target } }));
  encrypted[encrypted.length - 1] ^= 1; const bad = path.join(directory, 'corrupt.enc'); await fs.writeFile(bad, encrypted);
  await assert.rejects(execute(process.execPath, [script, 'restore', bad, corruptDb], { env: { ...env, STORAGE_DIR: path.join(directory, 'bad') } }));
  assert.equal((await client.db(corruptDb).listCollections().toArray()).length, 0);
});
