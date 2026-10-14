const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { MongoClient } = require('mongodb');
const { loadConfig } = require('../src/config');
const { Storage } = require('../src/storage');
const { initialize } = require('../src/database');
const { createApp } = require('../src/app');
test('Mongo-backed transfer lifecycle, OTP races, authorization, expiry, tamper and restart', async t => {
  try {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'integration-'));
  const client = new MongoClient(process.env.TEST_MONGO_URI || 'mongodb://mongo:27017'); await client.connect();
  const db = client.db(`test_${crypto.randomBytes(8).toString('hex')}`);
  let server;
  t.after(async () => {
    if (server) await new Promise(resolve => server.close(resolve));
    await db.dropDatabase(); await client.close(); await fs.rm(directory, { recursive: true, force: true });
  });
  const sent = [];
  const config = loadConfig({ ENCRYPTION_KEY: '12'.repeat(32), OTP_SECRET: '34'.repeat(32), MONGO_URI: 'mongodb://mongo/test', SMTP_HOST: 'mail', MAX_FILE_SIZE: '1024' });
  config.storage = directory;
  await initialize(db); const storage = new Storage(config); await storage.init();
  const dependencies = { config, db, storage, scanner: { async scan() { return { clean: true }; } }, mail: { async sendMail(message) { sent.push(message); } } };
  let running = createApp(dependencies);
  server = running.app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  let base = `http://127.0.0.1:${server.address().port}`;
  const request = (url, token, method = 'GET', body) => fetch(base + url, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}) }, body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined });
  assert.equal((await request('/ready')).status, 200);
  for (const address of ['a,b@example.com', 'a(comment)@example.com', 'a@example.com\r\nBcc: victim@example.com']) {
    assert.equal((await request('/api/request-otp', null, 'POST', { email: address })).status, 400);
  }
  const login = async address => {
    const result = await (await request('/api/request-otp', null, 'POST', { email: address })).json();
    const code = sent.at(-1).text.match(/\b\d{6}\b/)[0];
    const body = { sessionId: result.sessionId, otp: code };
    const verified = await request('/api/verify-otp', null, 'POST', body); assert.equal(verified.status, 200);
    const token = (await verified.json()).token;
    assert.equal((await request('/api/verify-otp', null, 'POST', body)).status, 401);
    return token;
  };
  const owner = await login('owner@example.com'), recipient = await login('recipient@example.com'), stranger = await login('stranger@example.com');
  const otpRequest = await (await request('/api/request-otp', null, 'POST', { email: 'race@example.com' })).json();
  const otpBody = { sessionId: otpRequest.sessionId, otp: sent.at(-1).text.match(/\b\d{6}\b/)[0] };
  const races = await Promise.all([request('/api/verify-otp', null, 'POST', otpBody), request('/api/verify-otp', null, 'POST', otpBody)]);
  assert.deepEqual(races.map(r => r.status).sort(), [200, 401]);
  const locked = await (await request('/api/request-otp', null, 'POST', { email: 'locked@example.com' })).json();
  const correct = sent.at(-1).text.match(/\b\d{6}\b/)[0];
  for (let i = 0; i < 5; i++) assert.equal((await request('/api/verify-otp', null, 'POST', { sessionId: locked.sessionId, otp: correct === '000000' ? '111111' : '000000' })).status, 401);
  assert.equal((await request('/api/verify-otp', null, 'POST', { sessionId: locked.sessionId, otp: correct })).status, 401);
  assert.equal((await request('/api/request-otp', null, 'POST', { email: 'owner@example.com' })).status, 429);
  const expiredChallenge = await (await request('/api/request-otp', null, 'POST', { email: 'expired@example.com' })).json();
  const expiredCode = sent.at(-1).text.match(/\b\d{6}\b/)[0];
  await db.collection('challenges').updateOne({ id: expiredChallenge.sessionId }, { $set: { expiresAt: new Date(0) } });
  assert.equal((await request('/api/verify-otp', null, 'POST', { sessionId: expiredChallenge.sessionId, otp: expiredCode })).status, 401);
  const bytes = crypto.randomBytes(512);
  const upload = async (payload = bytes, address = 'recipient@example.com') => {
    const form = new FormData(); form.append('file', new Blob([payload]), '<img src=x onerror=alert(1)>.txt'); form.append('recipient', address); form.append('expiryHours', '24');
    return request('/api/upload', owner, 'POST', form);
  };
  assert.equal((await request('/api/files')).status, 401);
  const uploaded = await upload(); assert.equal(uploaded.status, 201); const { fileId } = await uploaded.json();
  assert.equal((await request(`/api/file/${fileId}/download`, recipient)).status, 404);
  await running.worker.tick();
  assert.equal((await request(`/api/file/${fileId}/download`, stranger)).status, 404);
  assert.equal((await request(`/api/file/${fileId}`, recipient, 'DELETE')).status, 404);
  assert.equal((await (await request('/api/files', stranger)).json()).files.length, 0);
  let download = await request(`/api/file/${fileId}/download`, recipient);
  assert.equal(download.status, 200); assert.match(download.headers.get('content-disposition'), /^attachment/); assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
  assert.equal((await upload(Buffer.alloc(2048))).status, 413);
  assert.equal((await upload(bytes, 'bad')).status, 400);
  assert.equal((await fs.readdir(directory)).length, 1);
  // A fresh app instance reads persisted identity, metadata and ciphertext.
  await new Promise(resolve => server.close(resolve));
  running = createApp(dependencies); server = running.app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve)); base = `http://127.0.0.1:${server.address().port}`;
  assert.deepEqual(Buffer.from(await (await request(`/api/file/${fileId}/download`, recipient)).arrayBuffer()), bytes);
  const file = await db.collection('transfers').findOne({ _id: fileId });
  const original = await fs.readFile(storage.objectPath(file.objectId)); const corrupt = Buffer.from(original); corrupt[0] ^= 1; await fs.writeFile(storage.objectPath(file.objectId), corrupt);
  download = await request(`/api/file/${fileId}/download`, recipient); assert.equal(download.status, 500); assert.match(await download.text(), /could not be completed/);
  await fs.writeFile(storage.objectPath(file.objectId), original);
  await db.collection('transfers').updateOne({ _id: fileId }, { $set: { expiresAt: new Date(0) } });
  assert.equal((await request(`/api/file/${fileId}/download`, recipient)).status, 404);
  await running.cleanup(); assert.deepEqual(await fs.readdir(directory), []);
  const another = await (await upload()).json();
  assert.equal((await request(`/api/file/${another.fileId}`, owner, 'DELETE')).status, 200);
  assert.equal((await request(`/api/file/${another.fileId}/download`, recipient)).status, 404);
  // Failure leaves the deletion tombstone in place for a subsequent retry.
  const remove = storage.remove.bind(storage); storage.remove = async () => { throw new Error('Storage outage'); };
  await assert.rejects(running.cleanup());
  assert.equal((await db.collection('transfers').findOne({ _id: another.fileId })).status, 'deleting');
  storage.remove = remove; await running.cleanup(); assert.deepEqual(await fs.readdir(directory), []);
  await request('/api/logout', owner, 'POST', {}); assert.equal((await request('/api/files', owner)).status, 401);
  assert.ok(await db.collection('audit').countDocuments({ action: 'DOWNLOAD' }));
  const originalReady = storage.ready.bind(storage);
  storage.ready = async () => { throw new Error('Storage unavailable'); };
  assert.equal((await request('/ready')).status, 503);
  storage.ready = originalReady;
  } catch (error) { console.error(error); throw error; }
});
