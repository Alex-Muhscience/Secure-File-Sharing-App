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

test('enterprise dashboards enforce platform and tenant boundaries and persist guarded subscription changes', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'enterprise-'));
  const client = new MongoClient(process.env.TEST_MONGO_URI || 'mongodb://mongo:27017');
  const db = client.db(`enterprise_${crypto.randomBytes(6).toString('hex')}`);
  let server;
  t.after(async () => { if (server) await new Promise(resolve => server.close(resolve)); await db.dropDatabase(); await client.close(); await fs.rm(directory, { recursive: true, force: true }); });
  await client.connect(); await initialize(db);
  const config = loadConfig({ ENCRYPTION_KEY: '12'.repeat(32), OTP_SECRET: '34'.repeat(32), MONGO_URI: 'mongodb://mongo/test', SMTP_HOST: 'mail', PLATFORM_ADMIN_EMAILS: 'operator@example.com' });
  config.storage = directory;
  const storage = new Storage(config); await storage.init();
  const sent = [];
  const { app, pilot } = createApp({ db, config, storage, scanner: { async scan() { return { clean: true }; } }, mail: { async sendMail(message) { sent.push(message); } } });
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (url, token, org, method = 'GET', body) => fetch(base + url, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(org ? { 'X-Organization-ID': org } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const login = async email => {
    const challenge = await (await request('/api/request-otp', null, null, 'POST', { email })).json();
    return (await (await request('/api/verify-otp', null, null, 'POST', { sessionId: challenge.sessionId, otp: sent.at(-1).text.match(/\b\d{6}\b/)[0] })).json()).token;
  };
  const owner = await login('client@example.com'), other = await login('other@example.com'), viewer = await login('viewer@example.com'), operator = await login('operator@example.com');
  const org = await pilot.createTeam('client@example.com', 'Client A'), otherOrg = await pilot.createTeam('other@example.com', 'Client B');
  await db.collection('organizations').updateOne({ _id: org._id }, { $push: { members: { email: 'viewer@example.com', role: 'viewer' } } });
  assert.equal((await request('/api/platform/clients')).status, 401);
  assert.equal((await request('/api/platform/clients', owner)).status, 403, 'Workspace ownership must not grant platform access');
  assert.equal((await (await request('/api/me', owner)).json()).platformAdmin, false);
  assert.equal((await (await request('/api/me', operator)).json()).platformAdmin, true);
  for (const endpoint of ['/api/analytics', '/api/billing/overview']) {
    assert.equal((await request(endpoint, other, org._id)).status, 404);
    assert.equal((await request(endpoint, viewer, org._id)).status, 403);
    assert.equal((await request(endpoint, owner, org._id)).status, 200);
  }
  const at = new Date();
  await db.collection('usage').insertMany([
    { _id: 'u1', orgId: org._id, type: 'upload', bytes: 1000, storedBytes: 200, at },
    { _id: 'u2', orgId: org._id, type: 'download', bytes: 1000, at },
    { _id: 'u3', orgId: otherOrg._id, type: 'upload', bytes: 777777, at },
  ]);
  const analytics = await (await request('/api/analytics?days=7', owner, org._id)).json();
  assert.equal(analytics.totals.uploadBytes, 1000); assert.equal(analytics.totals.downloadBytes, 1000);
  assert.equal(analytics.totals.uploads, 1); assert.equal(analytics.series.length, 7);
  assert.equal(analytics.totals.compressionSavedBytes, 800);
  assert.equal((await request('/api/analytics?days=800', owner, org._id)).status, 400);
  const billing = await (await request('/api/billing/overview', owner, org._id)).json();
  assert.deepEqual(billing.invoices, []); assert.equal(billing.subscription.provider, 'manual');
  assert.equal(billing.providers.length, 3); assert.ok(billing.providers.every(provider => provider.available === false));
  for (const provider of ['stripe', 'mpesa', 'crypto']) assert.equal((await request('/api/billing/checkout', owner, org._id, 'POST', { provider, plan: 'team' })).status, 503);
  await db.collection('invoices').insertMany([
    { _id: 'real', orgId: org._id, currency: 'kes', amountMinor: 250000, status: 'paid', test: false, at },
    { _id: 'test', orgId: otherOrg._id, currency: 'kes', amountMinor: 990000, status: 'paid', test: true, at },
  ]);
  assert.equal((await (await request('/api/billing/overview', owner, org._id)).json()).invoices.length, 1);
  assert.equal((await request(`/api/platform/clients/${org._id}/subscription`, owner, null, 'PUT', {})).status, 403);
  const change = { plan: 'team', status: 'suspended', revision: 0, reason: 'Pilot review requested by the account owner' };
  assert.equal((await request(`/api/platform/clients/${org._id}/subscription`, operator, null, 'PUT', change)).status, 200);
  assert.equal((await request(`/api/platform/clients/${org._id}/subscription`, operator, null, 'PUT', change)).status, 409, 'Stale edits must not overwrite a newer subscription');
  let saved = await db.collection('organizations').findOne({ _id: org._id });
  assert.equal(saved.status, 'suspended'); assert.equal(saved.subscription.revision, 1);
  await db.collection('organizations').updateOne({ _id: org._id }, { $set: { usedBytes: 200 * 1024 * 1024 } });
  assert.equal((await request(`/api/platform/clients/${org._id}/subscription`, operator, null, 'PUT', { ...change, plan: 'pilot', status: 'active', revision: 1 })).status, 409);
  const listed = await (await request('/api/platform/clients?search=Client&limit=1', operator)).json();
  assert.equal(listed.clients.length, 1); assert.ok(listed.nextCursor);
  assert.equal(Object.hasOwn(listed.clients[0], 'reservations'), false);
  assert.equal((await (await request(`/api/platform/clients?search=Client&limit=1&cursor=${listed.nextCursor}`, operator)).json()).clients.length, 1);
  assert.equal((await request('/api/platform/clients?search=%5B&limit=1', operator)).status, 200, 'Search treats regex metacharacters as ordinary text');
  const platform = await (await request('/api/platform/analytics?days=30', operator)).json();
  assert.deepEqual(platform.revenue, [{ currency: 'kes', amountMinor: 250000 }]);
  assert.equal(await db.collection('audit').countDocuments({ action: 'SUBSCRIPTION_MANUAL', actor: 'operator@example.com', orgId: org._id }), 1);
  await db.collection('organizations').updateOne({ _id: otherOrg._id }, { $set: { subscription: { provider: 'stripe', mode: 'recurring', status: 'active', periodEnd: new Date(Date.now() + 86400000), revision: 1 } } });
  const accessRoute = `/api/platform/clients/${otherOrg._id}/access`, accessChange = { status: 'suspended', revision: 0, reason: 'Account review requested by the operator' };
  assert.equal((await request(accessRoute, other, null, 'PUT', accessChange)).status, 403);
  assert.equal((await request(accessRoute, operator, null, 'PUT', accessChange)).status, 200);
  assert.equal((await db.collection('organizations').findOne({ _id: otherOrg._id })).adminSuspended, true);
  assert.equal((await request(accessRoute, operator, null, 'PUT', { ...accessChange, status: 'active', revision: 1 })).status, 200);
  await db.collection('organizations').updateOne({ _id: otherOrg._id }, { $set: { 'subscription.periodEnd': new Date(0) } });
  assert.equal((await request(accessRoute, operator, null, 'PUT', { ...accessChange, status: 'active', revision: 2 })).status, 200);
  assert.equal((await db.collection('organizations').findOne({ _id: otherOrg._id })).status, 'suspended', 'Clearing an operator pause cannot reactivate expired paid access');
});
