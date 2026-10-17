const crypto = require('node:crypto');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const missing = error => error.code === 'ENOENT' || error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404;
async function migrateStorage({ db, storage, target, onProgress = () => {} }) {
  if (!['s3', 'filesystem'].includes(target)) throw new Error('Invalid migration target');
  await storage.store(target).ready();
  storage.attach(db);
  const transfers = db.collection('transfers'), chunks = db.collection('chunks'); let migrated = 0;
  async function move(collection, file) {
    const source = file.storageBackend || 'filesystem'; if (source === target) return false;
    const ciphertext = await storage.readCiphertext(file); storage.authenticate(file, ciphertext);
    let existing;
    try { existing = await storage.store(target).read(file.objectId, 64 * 1024 * 1024); }
    catch (error) { if (!missing(error)) throw error; }
    if (existing && digest(existing) !== digest(ciphertext)) throw new Error('Destination object conflicts with authenticated source');
    if (!existing) await storage.importCiphertext(file.objectId, ciphertext, target);
    const verified = await storage.store(target).read(file.objectId, 64 * 1024 * 1024);
    if (digest(verified) !== digest(ciphertext)) throw new Error('Destination verification failed');
    storage.authenticate(file, verified);
    const result = await collection.updateOne({ _id: file._id, ...(file.status ? { status: file.status } : {}),
      ...(file.storageBackend ? { storageBackend: source } : { storageBackend: { $exists: false } }),
    }, { $set: { storageBackend: target, storageMigratedAt: new Date() }, $addToSet: { retainedBackends: source } });
    // If revocation won the metadata race, its worker may already have finished deletion.
    if (!result.modifiedCount) {
      const current = await collection.findOne({ _id: file._id });
      if (!current || ['deleting', 'deleted'].includes(current.status)) await storage.remove(file.objectId, target);
    }
    return !!result.modifiedCount;
  }
  for await (const part of chunks.find()) await move(chunks, part);
  for await (const file of transfers.find({ status: { $in: ['active', 'quarantined', 'blocked'] } })) {
    if (file.format === 'segments-v1') {
      await storage.segmented.verifyManifest(file);
      if (file.storageBackend === target) continue;
      const result = await transfers.updateOne({ _id: file._id, status: file.status }, { $set: { storageBackend: target, storageMigratedAt: new Date() } });
      migrated += result.modifiedCount;
    } else migrated += Number(await move(transfers, file));
    onProgress(migrated);
  }
  return migrated;
}
module.exports = { migrateStorage };
