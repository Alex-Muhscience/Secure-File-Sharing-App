const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { MongoClient } = require('mongodb');
const { Worker } = require('../src/worker');
test('notifications and billing maintenance continue while a large scan is in progress', async t => {
  const client = new MongoClient(process.env.TEST_MONGO_URI || 'mongodb://mongo:27017');
  await client.connect();
  const db = client.db(`maintenance_${crypto.randomBytes(6).toString('hex')}`);
  let release, started;
  const scanning = new Promise(resolve => { started = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  let mailed = 0, reconciled = 0;
  const worker = new Worker({ db, config: { scanMaxSize: 100, baseUrl: 'http://localhost', from: 'test@example.com' },
    storage: { async decrypt() { return Buffer.alloc(1); } },
    scanner: { async scan() { started(); await held; return { clean: true }; } },
    mail: { async sendMail() { mailed++; } }, audit: async () => {},
    payments: { async tick() { reconciled++; } },
  });
  const now = new Date(), expiresAt = new Date(Date.now() + 3600000);
  await db.collection('transfers').insertMany([
    { _id: crypto.randomUUID(), size: 1, status: 'quarantined', expiresAt },
    { _id: crypto.randomUUID(), status: 'active', expiresAt, notification: { status: 'pending', attempts: 0, nextAttempt: now } },
  ]);
  const active = worker.tick();
  t.after(async () => { release(); await active; await db.dropDatabase(); await client.close(); });
  await scanning;
  assert.equal(mailed, 0);
  await worker.maintain();
  assert.equal(mailed, 1, 'An unrelated ready transfer is delivered during the held scan');
  assert.ok(reconciled >= 2, 'Billing reconciliation continues independently');
  release(); await active;
});
