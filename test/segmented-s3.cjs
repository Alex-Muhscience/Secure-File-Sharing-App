const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const { MongoClient } = require('mongodb');
const { loadConfig } = require('../src/config');
const { initialize } = require('../src/database');
const { Storage } = require('../src/storage');
const { migrateStorage } = require('../src/migration');
const execute = promisify(execFile);
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
async function streamHash(storage, file) {
  const hash = crypto.createHash('sha256'); let size = 0;
  for await (const bytes of storage.plaintext(file)) { hash.update(bytes); size += bytes.length; }
  assert.equal(size, file.size); return hash.digest('hex');
}
test('segmented files migrate, rotate keys, and recover to filesystem and private S3', { skip: process.env.TEST_S3 !== 'true' }, async t => {
  const marker = crypto.randomBytes(6).toString('hex'), directory = await fs.mkdtemp(path.join(os.tmpdir(), 'segmented-s3-'));
  const client = new MongoClient(process.env.TEST_MONGO_URI || 'mongodb://mongo:27017');
  await client.connect();
  const names = [`segmented_${marker}`, `restore_segmented_fs_${marker}`, `restore_segmented_remote_${marker}`], db = client.db(names[0]);
  const sourceUri = new URL(process.env.TEST_MONGO_URI || 'mongodb://mongo:27017'); sourceUri.pathname = `/${names[0]}`;
  const env = { ...process.env, ENCRYPTION_KEY: '12'.repeat(32), OTP_SECRET: '34'.repeat(32), BACKUP_KEY: '56'.repeat(32), MONGO_URI: sourceUri.toString(), SMTP_HOST: 'mail', STORAGE_DRIVER: 'filesystem', STORAGE_DIR: path.join(directory, 'source'), S3_PREFIX: `segments-${marker}/` };
  const config = loadConfig(env), storage = new Storage(config), remote = new Storage({ ...config, storageDriver: 's3', s3: { ...config.s3, prefix: `recovered-segments-${marker}/` } });
  t.after(async () => {
    for (const instance of [storage, remote]) {
      for await (const object of instance.list()) await instance.remove(object.id, object.backend);
      instance.close();
    }
    for (const name of names) await client.db(name).dropDatabase();
    await client.close(); await fs.rm(directory, { recursive: true, force: true });
  });
  await initialize(db); await storage.init(); await remote.init(); storage.attach(db);
  const chunkSize = 8 * 1024 * 1024, bits=crypto.randomBytes(chunkSize/8),walk=Buffer.alloc(chunkSize);let value=0;
  for(let i=0;i<walk.length;i++){value=(value+((bits[i>>3]>>(i&7))&1))&255;walk[i]=value;}
  const parts = [crypto.randomBytes(chunkSize), walk, crypto.randomBytes(2 * 1024 * 1024),Buffer.alloc(1024*1024,65)];
  const expected = digest(Buffer.concat(parts)), id = crypto.randomUUID(), objectId = crypto.randomUUID();
  const file = { _id: id, objectId, format: 'segments-v1', storageBackend: 'filesystem', name: 'Archive.bin', owner: 'owner@example.com', recipient: 'recipient@example.com', status: 'active', size: 0, storedSize: 0, chunkSize, chunkCount: parts.length, createdAt: new Date(), expiresAt: new Date(Date.now() + 86400000), ...storage.wrap(crypto.randomBytes(32), objectId) };
  for (const [index, bytes] of parts.entries()) {
    const part = await storage.writePart({ uploadId: id, index, offset: file.size }, bytes, index===1?'research':'auto');
    if(index===1)assert.equal(part.codec,'stp1','Predictive custom bytes survive encrypted storage and recovery');
    await db.collection('chunks').insertOne({ _id: crypto.randomUUID(), ...part });
    file.size += bytes.length; file.storedSize += part.storedSize;
  }
  file.manifestMac = await storage.segmented.manifest(file);
  await db.collection('transfers').insertOne(file);
  assert.equal(await streamHash(storage, file), expected);
  assert.equal(await migrateStorage({ db, storage, target: 's3' }), 1);
  const migrated = await db.collection('transfers').findOne({ _id: id });
  assert.equal(await db.collection('chunks').countDocuments({ storageBackend: 's3' }), parts.length);
  assert.equal(await streamHash(storage, migrated), expected);
  const rotatedEnv = { ...env, STORAGE_DRIVER: 's3', ENCRYPTION_KEYS: JSON.stringify({ current: '78'.repeat(32) }), ENCRYPTION_KEY_ID: 'current' };
  await execute(process.execPath, [path.join(__dirname, '../scripts/rotate-keys.cjs')], { env: rotatedEnv });
  const rotatedConfig = loadConfig(rotatedEnv), rotated = new Storage({ ...rotatedConfig, keys: { current: Buffer.from('78'.repeat(32), 'hex') } }); rotated.attach(db);
  const root = await db.collection('transfers').findOne({ _id: id });
  assert.equal(root.keyId, 'current');
  assert.equal(await db.collection('chunks').countDocuments({ keyId: 'current' }), parts.length);
  assert.equal(await streamHash(rotated, root), expected); rotated.close();
  const archive = path.join(directory, 'backup.enc'), backupScript = path.join(__dirname, '../scripts/backup.cjs');
  await execute(process.execPath, [backupScript, 'create', archive], { env: rotatedEnv });
  const restoreDirectory = path.join(directory, 'restore');
  await execute(process.execPath, [backupScript, 'restore', archive, names[1]], { env: { ...rotatedEnv, STORAGE_DRIVER: 'filesystem', S3_ENDPOINT: '', STORAGE_DIR: restoreDirectory } });
  const restoredFS = new Storage({ ...rotatedConfig, storageDriver: 'filesystem', s3: null, storage: restoreDirectory }); restoredFS.attach(client.db(names[1]));
  assert.equal(await streamHash(restoredFS, await client.db(names[1]).collection('transfers').findOne({ _id: id })), expected); restoredFS.close();
  await execute(process.execPath, [backupScript, 'restore', archive, names[2]], { env: { ...rotatedEnv, S3_PREFIX: remote.config.s3.prefix, STORAGE_DIR: path.join(directory, 'remote') } });
  const restoredRemote = new Storage({ ...rotatedConfig, s3: remote.config.s3 }); restoredRemote.attach(client.db(names[2]));
  assert.equal(await streamHash(restoredRemote, await client.db(names[2]).collection('transfers').findOne({ _id: id })), expected); restoredRemote.close();
  const reverse = new Storage(rotatedConfig);
  try { assert.equal(await migrateStorage({ db, storage: reverse, target: 'filesystem' }), 1); }
  finally { reverse.close(); }
});
