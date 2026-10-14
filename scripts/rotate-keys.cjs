const { MongoClient } = require('mongodb');
const { loadConfig } = require('../src/config');
const { Storage } = require('../src/storage');
async function main() {
  const config = loadConfig(), storage = new Storage(config), client = new MongoClient(config.mongoUri);
  try {
    await client.connect(); const transfers = client.db().collection('transfers'); let count = 0;
    for await (const file of transfers.find({ status: { $ne: 'deleted' }, $or: [{ version: 1 }, { keyId: { $ne: config.keyId } }] })) {
      await storage.decrypt(file);
      const wrapped = storage.rewrap(file);
      const result = await transfers.updateOne({ _id: file._id, version: file.version, ...(file.keyId ? { keyId: file.keyId } : {}) }, { $set: wrapped });
      count += result.modifiedCount;
    }
    console.log(`Rewrapped ${count} files to key ID ${config.keyId}. Preserve old keys for backups.`);
  } finally { await client.close(); }
}
main().catch(error => { console.error('Key rotation failed:', error.name); process.exitCode = 1; });
