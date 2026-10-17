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
  let timer, maintenanceTimer, cleanupTimer, closing = false, activeTick = Promise.resolve(), activeMaintenance = Promise.resolve(), activeCleanup = Promise.resolve();
  const tick = () => {
    activeTick = worker.tick().catch(error => console.error('Worker failed:', error.name));
    activeTick.finally(() => { if (!closing) timer = setTimeout(tick, 2000); });
  };
  const maintain = () => {
    activeMaintenance = worker.maintain().catch(error => console.error('Maintenance failed:', error.name));
    activeMaintenance.finally(() => { if (!closing) maintenanceTimer = setTimeout(maintain, 2000); });
  };
  const clean = () => {
    activeCleanup = cleanup().catch(error => console.error('Cleanup failed:', error.name));
    activeCleanup.finally(() => { if (!closing) cleanupTimer = setTimeout(clean, 60000); });
  };
  if (config.workerOnly) { console.log('Transfer worker started'); tick(); maintain(); clean(); }
  const shutdown = () => {
    if (closing) return; closing = true; clearTimeout(timer); clearTimeout(maintenanceTimer); clearTimeout(cleanupTimer);
    const timeout = setTimeout(() => process.exit(1), 15000); timeout.unref();
    const finish = async () => { await Promise.all([activeTick, activeMaintenance, activeCleanup]); mail.close(); storage.close(); await client.close(); clearTimeout(timeout); };
    if (server) server.close(() => finish().catch(() => process.exit(1)));
    else finish().catch(() => process.exit(1));
  };
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
}
main().catch(error => { console.error('Startup failed:', error.message.replace(/mongodb[^\s]*/g, '[database]')); process.exit(1); });
