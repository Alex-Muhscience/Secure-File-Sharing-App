// Run in the app container: node /app/scripts/smoke.cjs
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const base = process.env.SMOKE_APP_URL || 'http://127.0.0.1:3000';
const inbox = process.env.SMOKE_MAIL_URL || 'http://mail:8025';
const request = (url, token, method = 'GET', body) => fetch(base + url, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body && !(body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}) }, body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined });
async function signIn(address) {
  const response = await request('/api/request-otp', null, 'POST', { email: address }); assert.equal(response.status, 200);
  const { sessionId } = await response.json();
  const messages = await (await fetch(`${inbox}/api/v1/messages`)).json();
  const message = messages.messages.find(message => message.To.some(to => to.Address === address)); assert.ok(message, 'Verification email delivered');
  const contents = await (await fetch(`${inbox}/api/v1/message/${message.ID}`)).json();
  const otp = contents.Text.match(/\b\d{6}\b/)[0];
  const verified = await request('/api/verify-otp', null, 'POST', { sessionId, otp }); assert.equal(verified.status, 200);
  return (await verified.json()).token;
}
async function main() {
  assert.equal((await request('/ready')).status, 200);
  const marker = crypto.randomBytes(6).toString('hex');
  const owner = await signIn(`smoke-owner-${marker}@example.com`), address = `smoke-recipient-${marker}@example.com`;
  const bytes = crypto.randomBytes(4096), form = new FormData();
  form.append('file', new Blob([bytes]), 'smoke.bin'); form.append('recipient', address); form.append('expiryHours', '1');
  const uploaded = await request('/api/upload', owner, 'POST', form); assert.equal(uploaded.status, 201);
  const result = await uploaded.json(); assert.equal(result.notified, true);
  const recipient = await signIn(address);
  const downloaded = await request(`/api/file/${result.fileId}/download`, recipient);
  assert.equal(downloaded.status, 200); assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), bytes);
  assert.equal((await request(`/api/file/${result.fileId}`, owner, 'DELETE')).status, 200);
  assert.equal((await request(`/api/file/${result.fileId}/download`, recipient)).status, 404);
  await request('/api/logout', owner, 'POST', {}); await request('/api/logout', recipient, 'POST', {});
  console.log('PASS: live SMTP code delivery, sender upload, recipient byte-for-byte download, revocation and logout');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
