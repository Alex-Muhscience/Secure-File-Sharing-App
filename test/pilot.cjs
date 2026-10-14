const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { MongoClient } = require('mongodb');
const { loadConfig } = require('../src/config');
const { Storage } = require('../src/storage');
const { initialize } = require('../src/database');
const { createApp } = require('../src/app');
test('pilot tenant isolation, roles, atomic quotas, quarantine, durable retries and sandbox idempotency', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pilot-'));
  const client = new MongoClient(process.env.TEST_MONGO_URI || 'mongodb://mongo:27017');
  const db = client.db(`pilot_${crypto.randomBytes(6).toString('hex')}`);
  let server;
  t.after(async () => { if (server) await new Promise(resolve => server.close(resolve)); await db.dropDatabase(); await client.close(); await fs.rm(directory, { recursive: true, force: true }); });
  await client.connect(); await initialize(db);
  const config = loadConfig({ ENCRYPTION_KEY: '12'.repeat(32), OTP_SECRET: '34'.repeat(32), MONGO_URI: 'mongodb://mongo/test', SMTP_HOST: 'mail', MAX_FILE_SIZE: '1024', BILLING_SANDBOX: 'true' }); config.storage = directory;
  const storage = new Storage(config); await storage.init();
  let scannerDown = false, infected = false, mailDown = false, mailCount = 0;
  const sent = [];
  const dependencies = { db, config, storage,
    scanner: { async scan() { if (scannerDown) throw new Error('Scanner outage'); return { clean: !infected }; } },
    mail: { async sendMail(message) { if (mailDown) throw new Error('SMTP outage'); sent.push(message); mailCount++; } },
  };
  let running = createApp(dependencies); server = running.app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (url, token, org, method = 'GET', body) => fetch(base + url, { method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(org ? { 'X-Organization-ID': org } : {}), ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}) },
    body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined });
  const login = async email => {
    const challenge = await (await request('/api/request-otp', null, null, 'POST', { email })).json();
    const otp = sent.at(-1).text.match(/\b\d{6}\b/)[0];
    return (await (await request('/api/verify-otp', null, null, 'POST', { sessionId: challenge.sessionId, otp })).json()).token;
  };
  const a = await login('a@example.com'), b = await login('b@example.com'), viewer = await login('viewer@example.com');
  const orgA = (await (await request('/api/organizations', a, null, 'POST', { name: 'Team A' })).json()).organization._id;
  const orgB = (await (await request('/api/organizations', b, null, 'POST', { name: 'Team B' })).json()).organization._id;
  assert.equal((await request(`/api/organizations/${orgA}/members`, b, null, 'PUT', { email: 'b@example.com', role: 'admin' })).status, 404);
  assert.equal((await request(`/api/organizations/${orgA}/members`, a, null, 'PUT', { email: 'viewer@example.com', role: 'viewer' })).status, 200);
  const upload = (token = a, org = orgA, recipient = 'a@example.com') => {
    const form = new FormData(); form.append('file', new Blob([Buffer.alloc(512, 1)]), 'document.bin'); form.append('recipient', recipient); form.append('expiryHours', '24');
    return request('/api/upload', token, org, 'POST', form);
  };
  assert.equal((await upload(b, orgA)).status, 404);
  assert.equal((await upload(viewer, orgA)).status, 403);
  const file = await (await upload()).json(); assert.equal(file.status, 'quarantined');
  assert.equal((await request(`/api/file/${file.fileId}/download`, a, orgA)).status, 404);
  scannerDown = true; await running.worker.tick();
  assert.equal((await db.collection('transfers').findOne({ _id: file.fileId })).status, 'quarantined');
  scannerDown = false; mailDown = true; await db.collection('transfers').updateOne({ _id: file.fileId }, { $unset: { scanRetryAt: '' } });
  await running.worker.tick();
  let row = await db.collection('transfers').findOne({ _id: file.fileId }); assert.equal(row.status, 'active'); assert.equal(row.notification.status, 'pending');
  // The jobs survive replacement of the application/worker object.
  running = createApp(dependencies); mailDown = false;
  await db.collection('transfers').updateOne({ _id: file.fileId }, { $set: { 'notification.nextAttempt': new Date(0) } });
  const countBefore = mailCount; await Promise.all([running.worker.tick(), createApp(dependencies).worker.tick()]);
  assert.equal(mailCount, countBefore + 1); await running.worker.tick(); assert.equal(mailCount, countBefore + 1);
  assert.equal((await request(`/api/file/${file.fileId}/download`, b, orgB)).status, 404);
  assert.equal((await request(`/api/file/${file.fileId}`, b, orgB, 'DELETE')).status, 404);
  assert.equal((await (await request('/api/files', b, orgB)).json()).files.length, 0);
  assert.equal((await request('/api/audit/export', viewer, orgA)).status, 403);
  const auditA = await (await request('/api/audit/export', a, orgA)).text(); assert.match(auditA, /UPLOAD/);
  const auditB = await (await request('/api/audit/export', b, orgB)).text(); assert.ok(!auditB.includes(file.fileId));
  const org = await db.collection('organizations').findOne({ _id: orgA }); assert.equal(org.usedBytes, 512); assert.equal(org.fileCount, 1);
  // Two full-size reservations contend for one remaining slot.
  await db.collection('organizations').updateOne({ _id: orgA }, { $set: { usedBytes: org.limits?.storageBytes || 100 * 1024 * 1024 - 1024 } });
  const reservations = await Promise.all([running.pilot.reserve({ ...org, limits: { storageBytes: 100 * 1024 * 1024, files: 100 } }, 1024), running.pilot.reserve({ ...org, limits: { storageBytes: 100 * 1024 * 1024, files: 100 } }, 1024)]);
  assert.equal(reservations.filter(Boolean).length, 1);
  await running.pilot.release(orgA, reservations.find(Boolean));
  await db.collection('organizations').updateOne({ _id: orgA }, { $set: { usedBytes: 512 } });
  const event = { eventId: 'event_123456', plan: 'team', status: 'active' };
  assert.equal((await request('/api/billing/sandbox/events', viewer, orgA, 'POST', event)).status, 403);
  const events = await Promise.all([request('/api/billing/sandbox/events', a, orgA, 'POST', event), request('/api/billing/sandbox/events', a, orgA, 'POST', event)]);
  assert.ok(events.every(response => response.status === 200));
  assert.equal((await db.collection('organizations').findOne({ _id: orgA })).billingEvents.length, 1);
  assert.equal((await request('/api/billing/sandbox/events', a, orgA, 'POST', { ...event, plan: 'pilot' })).status, 409);
  assert.equal((await request('/api/billing/sandbox/events', a, orgA, 'POST', { eventId: 'suspend_12345', plan: 'team', status: 'suspended' })).status, 200);
  assert.equal((await upload()).status, 403);
  assert.equal((await request(`/api/file/${file.fileId}/download`, a, orgA)).status, 404);
  assert.equal((await request('/api/billing/sandbox/events', a, orgA, 'POST', { eventId: 'resume_12345', plan: 'team', status: 'active' })).status, 200);
  infected = true; const bad = await (await upload()).json(); await running.worker.tick();
  assert.equal((await db.collection('transfers').findOne({ _id: bad.fileId })).status, 'blocked');
  assert.equal((await request(`/api/file/${bad.fileId}/download`, a, orgA)).status, 404);
  await running.cleanup(); assert.equal((await db.collection('transfers').findOne({ _id: bad.fileId })).status, 'deleted');
  assert.equal((await db.collection('organizations').findOne({ _id: orgA })).usedBytes, 512);
  assert.equal((await request(`/api/file/${file.fileId}`, a, orgA, 'DELETE')).status, 200); await running.cleanup();
  row = await db.collection('organizations').findOne({ _id: orgA }); assert.equal(row.usedBytes, 0); assert.equal(row.fileCount, 0);
  assert.equal((await (await request('/api/usage', a, orgA)).json()).records.filter(record => record.type === 'upload').length, 2);
});
