const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { MongoClient } = require('mongodb');
const { loadConfig } = require('../src/config');
const { Storage } = require('../src/storage');
const { initialize } = require('../src/database');
const { createApp } = require('../src/app');
const { recipientKey } = require('../src/pilot');
test('authorization and quota state changes cannot use stale workspace snapshots', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'auth-races-'));
  const client = new MongoClient(process.env.TEST_MONGO_URI || 'mongodb://mongo:27017');
  const db = client.db(`race_${crypto.randomBytes(6).toString('hex')}`); let server;
  t.after(async () => { if (server) await new Promise(resolve => server.close(resolve)); await db.dropDatabase(); await client.close(); await fs.rm(directory, { recursive: true, force: true }); });
  await client.connect(); await initialize(db);
  const config = loadConfig({ ENCRYPTION_KEY: '12'.repeat(32), OTP_SECRET: '34'.repeat(32), MONGO_URI: 'mongodb://mongo/test', SMTP_HOST: 'mail', BILLING_SANDBOX: 'true', MAX_FILE_SIZE: '1024' }); config.storage = directory;
  const storage = new Storage(config); await storage.init(); const sent = [];
  const { app, worker, pilot } = createApp({ config, db, storage, scanner: { async scan() { return { clean: true }; } }, mail: { async sendMail(message) { sent.push(message); } } });
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (url, token, org, method = 'GET', body) => fetch(base + url, { method, headers: {
    ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(org ? { 'X-Organization-ID': org } : {}), ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}),
  }, body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined });
  const login = async email => {
    const challenge = await (await request('/api/request-otp', null, null, 'POST', { email })).json();
    return (await (await request('/api/verify-otp', null, null, 'POST', { sessionId: challenge.sessionId, otp: sent.at(-1).text.match(/\b\d{6}\b/)[0] })).json()).token;
  };
  const owner = await login('owner-race@example.com'), admin = await login('admin-race@example.com');
  const org = (await (await request('/api/organizations', owner, null, 'POST', { name: 'Race workspace' })).json()).organization._id;
  const creations = await Promise.all(Array.from({ length: 4 }, (_, index) => request('/api/organizations', owner, null, 'POST', { name: `Concurrent ${index}` })));
  assert.deepEqual(creations.map(response => response.status).sort(), [201, 201, 409, 409]);
  assert.equal(await db.collection('organizations').countDocuments({ owner: 'owner-race@example.com', _id: { $not: /^personal_/ } }), 3);
  await request(`/api/organizations/${org}/members`, owner, null, 'PUT', { email: 'admin-race@example.com', role: 'admin' });
  const form = new FormData(); form.append('file', new Blob([Buffer.from('secret')]), 'secret.txt'); form.append('recipient', 'owner-race@example.com');
  const uploaded = await request('/api/upload', owner, org, 'POST', form); assert.equal(uploaded.status, 201); const { fileId } = await uploaded.json(); await worker.tick();
  await db.collection('transfers').updateOne({ _id: fileId }, { $set: { recipientRevoked: true } });
  assert.equal((await request(`/api/file/${fileId}/download`, admin, org)).status, 200);
  await db.collection('transfers').updateOne({ _id: fileId }, { $unset: { recipientRevoked: '' }, $set: { downloads: 0 } });
  const originalDecrypt = storage.decrypt.bind(storage);
  storage.decrypt = async file => {
    const bytes = await originalDecrypt(file);
    await db.collection('organizations').updateOne({ _id: org }, { $pull: { members: { email: 'admin-race@example.com' } } });
    return bytes;
  };
  assert.equal((await request(`/api/file/${fileId}/download`, admin, org)).status, 404);
  assert.equal((await db.collection('transfers').findOne({ _id: fileId })).downloads, 0);
  storage.decrypt = originalDecrypt;
  const stale = await pilot.orgs.findOne({ _id: org });
  await pilot.orgs.updateOne({ _id: org }, { $set: { plan: 'team' } });
  assert.equal(await pilot.reserve({ ...stale, limits: { storageBytes: 100 * 1024 * 1024, files: 100 }, actorEmail: 'owner-race@example.com' }, 1), null);
  const teamSnapshot = await pilot.orgs.findOne({ _id: org });
  await pilot.orgs.updateOne({ _id: org }, { $set: { 'members.0.role': 'viewer' } });
  assert.equal(await pilot.reserve({ ...teamSnapshot, limits: { storageBytes: 1024 * 1024 * 1024, files: 1000 }, actorEmail: 'owner-race@example.com' }, 1), null);
  await pilot.orgs.updateOne({ _id: org }, { $set: { 'members.0.role': 'owner', usedBytes: 101 * 1024 * 1024 } });
  assert.equal((await request('/api/billing/sandbox/events', owner, org, 'POST', { eventId: 'downgrade_race_1', plan: 'pilot', status: 'active' })).status, 409);
  await pilot.orgs.updateOne({ _id: org }, { $set: { usedBytes: 6 } });
  // Revocation is authoritative in the tenant document even before grant rows are updated.
  await pilot.orgs.updateOne({ _id: org }, { $set: { [`recipientRevocations.${recipientKey('admin-race@example.com')}`]: new Date() } });
  const file = await db.collection('transfers').findOne({ _id: fileId });
  await db.collection('transfers').updateOne({ _id: fileId }, { $set: { recipient: 'admin-race@example.com' } });
  assert.equal((await request(`/api/file/${fileId}/download`, admin)).status, 404);
  assert.equal((await (await request('/api/files', admin)).json()).files.length, 0);
  await db.collection('transfers').updateOne({ _id: fileId }, { $set: { createdAt: new Date(Date.now() + 1000) } });
  assert.equal((await request(`/api/file/${fileId}/download`, admin)).status, 200);
  // Suspension after reading/authentication must also deny release of plaintext.
  storage.decrypt = async record => { const bytes = await originalDecrypt(record); await pilot.orgs.updateOne({ _id: org }, { $set: { status: 'suspended' } }); return bytes; };
  assert.equal((await request(`/api/file/${fileId}/download`, owner, org)).status, 404);
  storage.decrypt = originalDecrypt;
  await pilot.orgs.updateOne({ _id: org }, { $set: { status: 'active' } });
  const originalHandle = storage._handleFile.bind(storage);
  storage._handleFile = (req, part, cb) => originalHandle(req, part, async (error, stored) => {
    if (error) return cb(error);
    await pilot.orgs.updateOne({ _id: org }, { $set: { status: 'suspended' } });
    cb(null, stored);
  });
  const rejected = new FormData(); rejected.append('file', new Blob([Buffer.from('cancelled')]), 'cancelled.txt'); rejected.append('recipient', 'owner-race@example.com');
  assert.equal((await request('/api/upload', owner, org, 'POST', rejected)).status, 403);
  assert.equal((await pilot.orgs.findOne({ _id: org })).usedBytes, 6);
  assert.equal((await fs.readdir(directory)).length, 1);
  assert.equal(file.size, 6);
});
