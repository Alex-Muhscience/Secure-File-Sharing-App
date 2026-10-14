const crypto = require('node:crypto');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const missing = error => error.code === 'ENOENT' || error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404;
async function migrateStorage({ db, storage, target, onProgress = () => {} }) {
  if (!['s3', 'filesystem'].includes(target)) throw new Error('Invalid migration target');
  await storage.store(target).ready();
  const transfers = db.collection('transfers'); let migrated = 0;
  for await (const file of transfers.find({ status: { $in: ['active', 'quarantined', 'blocked'] } })) {
    const source = file.storageBackend || 'filesystem'; if (source === target) continue;
    const ciphertext = await storage.readCiphertext(file); storage.authenticate(file, ciphertext);
    let existing;
    try { existing = await storage.store(target).read(file.objectId, storage.config.maxSize); }
    catch (error) { if (!missing(error)) throw error; }
    if (existing && digest(existing) !== digest(ciphertext)) throw new Error('Destination object conflicts with authenticated source');
    if (!existing) await storage.importCiphertext(file.objectId, ciphertext, target);
    const verified = await storage.store(target).read(file.objectId, storage.config.maxSize);
    if (digest(verified) !== digest(ciphertext)) throw new Error('Destination verification failed');
    storage.authenticate(file, verified);
    const result = await transfers.updateOne({ _id: file._id, status: file.status,
      ...(file.storageBackend ? { storageBackend: source } : { storageBackend: { $exists: false } }),
    }, { $set: { storageBackend: target, storageMigratedAt: new Date() }, $addToSet: { retainedBackends: source } });
    migrated += result.modifiedCount; onProgress(migrated);
    // If revocation won the metadata race, its worker may already have finished deletion.
    if (!result.modifiedCount) {
      const current = await transfers.findOne({ _id: file._id });
      if (!current || ['deleting', 'deleted'].includes(current.status)) await storage.remove(file.objectId, target);
    }
  }
  return migrated;
}
module.exports = { migrateStorage };
