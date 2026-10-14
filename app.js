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
  const db = client.db(); await initialize(db);
  const storage = new Storage(config); await storage.init();
  const mail = nodemailer.createTransport(config.smtp);
  if (!config.workerOnly) await mail.verify();
  const { app, cleanup, worker, pilot } = createApp({ config, db, storage, mail });
  await pilot.migrate();
  await storage.checkReferences(db);
  const server = config.workerOnly ? null : app.listen(config.port, config.host, () => console.log(`Secure Transfer listening on port ${config.port}`));
  if (server) server.requestTimeout = 120000;
  let timer, closing = false, activeTick = Promise.resolve(), lastCleanup = 0;
  const tick = () => {
    activeTick = worker.tick().then(async () => {
      if (Date.now() - lastCleanup >= 60000) { lastCleanup = Date.now(); await cleanup(); }
    }).catch(error => console.error('Worker failed:', error.name));
    activeTick.finally(() => { if (!closing) timer = setTimeout(tick, 2000); });
  };
  if (config.workerOnly) { console.log('Transfer worker started'); tick(); }
  const shutdown = () => {
    if (closing) return; closing = true; clearTimeout(timer);
    const timeout = setTimeout(() => process.exit(1), 15000); timeout.unref();
    const finish = async () => { await activeTick; mail.close(); storage.close(); await client.close(); clearTimeout(timeout); };
    if (server) server.close(() => finish().catch(() => process.exit(1)));
    else finish().catch(() => process.exit(1));
  };
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
}
main().catch(error => { console.error('Startup failed:', error.message.replace(/mongodb[^\s]*/g, '[database]')); process.exit(1); });
