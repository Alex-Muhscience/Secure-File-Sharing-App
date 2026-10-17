const { MongoClient } = require('mongodb');
const { loadConfig } = require('../src/config');
const { Storage } = require('../src/storage');
async function main() {
  const config = loadConfig(), storage = new Storage(config), client = new MongoClient(config.mongoUri);
  try {
    await client.connect(); storage.attach(client.db()); let count = 0;
    for (const name of ['transfers', 'chunks', 'uploads']) {
    const records = client.db().collection(name);
    for await (const file of records.find({ status: { $nin: ['deleted', 'cancelled'] }, $or: [{ version: 1 }, { keyId: { $ne: config.keyId } }] })) {
      if (name === 'uploads') storage.dataKey(file);
      else await storage.verify(file);
      const wrapped = storage.rewrap(file);
      const result = await records.updateOne({ _id: file._id, version: file.version, ...(file.keyId ? { keyId: file.keyId } : {}) }, { $set: wrapped });
      count += result.modifiedCount;
    }
    }
    console.log(`Rewrapped ${count} files to key ID ${config.keyId}. Preserve old keys for backups.`);
  } finally { storage.close(); await client.close(); }
}
main().catch(error => { console.error('Key rotation failed:', error.name); process.exitCode = 1; });
