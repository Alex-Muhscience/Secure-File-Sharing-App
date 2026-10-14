const { MongoClient } = require('mongodb');
const nodemailer = require('nodemailer');
const { loadConfig } = require('./src/config');
const { initialize } = require('./src/database');
const { Storage } = require('./src/storage');
const { createApp } = require('./src/app');
async function main() {
  const config = loadConfig();
  const client = new MongoClient(config.mongoUri, { serverSelectionTimeoutMS: 5000 });
  await client.connect();
  const db = client.db();
  await initialize(db);
  const storage = new Storage(config); await storage.init();
  const mail = nodemailer.createTransport(config.smtp); await mail.verify();
  const { app, cleanup } = createApp({ config, db, storage, mail });
  await cleanup();
  const server = app.listen(config.port, config.host, () => console.log(`Secure Transfer listening on port ${config.port}`));
  server.requestTimeout = 120000;
  const timer = setInterval(() => cleanup().catch(error => console.error('Cleanup failed:', error.name)), 60000);
  let closing = false;
  const shutdown = () => {
    if (closing) return; closing = true; clearInterval(timer);
    const timeout = setTimeout(() => process.exit(1), 15000); timeout.unref();
    server.close(async () => { mail.close(); await client.close(); clearTimeout(timeout); });
  };
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
}
main().catch(error => { console.error('Startup failed:', error.message.replace(/mongodb[^\s]*/g, '[database]')); process.exit(1); });
