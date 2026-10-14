const { MongoClient } = require('mongodb');
const { loadConfig } = require('../src/config');
const { Storage } = require('../src/storage');
const { migrateStorage } = require('../src/migration');
async function main() {
  const target = process.argv[2];
  if (!['s3', 'filesystem'].includes(target)) throw new Error('Usage: migrate-storage.cjs s3|filesystem');
  const config = loadConfig(), storage = new Storage(config), client = new MongoClient(config.mongoUri);
  try {
    await client.connect(); await storage.init();
    const count = await migrateStorage({ db: client.db(), storage, target });
    console.log(`Verified and migrated ${count} transfers to ${target}. Source copies remain until transfer deletion.`);
  } finally { storage.close(); await client.close(); }
}
main().catch(error => { console.error('Storage migration failed:', error.name); process.exitCode = 1; });
