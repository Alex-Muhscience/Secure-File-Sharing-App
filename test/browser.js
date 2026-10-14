const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const base = process.env.BROWSER_APP_URL || 'http://127.0.0.1:3081';
const inbox = process.env.BROWSER_MAIL_URL || 'http://127.0.0.1:8025';
async function signIn(page, email) {
  await page.goto(base); await page.locator('#email').fill(email);
  await page.locator('#request-form button').click(); await page.locator('#verify-form').waitFor({ state: 'visible' });
  const messages = await (await fetch(`${inbox}/api/v1/messages`)).json();
  const entry = messages.messages.find(message => message.To.some(to => to.Address === email)); assert.ok(entry);
  const message = await (await fetch(`${inbox}/api/v1/message/${entry.ID}`)).json();
  await page.locator('#code').fill(message.Text.match(/\b\d{6}\b/)[0]); await page.locator('#verify-form button').click();
  await page.locator('#workspace').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('#organization').options.length > 0);
}
async function main() {
  const browser = await chromium.launch({ headless: true });
  try {
    const sender = await browser.newPage({ viewport: { width: 1100, height: 900 } }), recipient = await browser.newPage();
    const errors = []; sender.on('pageerror', error => errors.push(error.message)); recipient.on('pageerror', error => errors.push(error.message));
    const marker = crypto.randomBytes(6).toString('hex'), senderEmail = `browser-sender-${marker}@example.com`, recipientEmail = `browser-recipient-${marker}@example.com`;
    await signIn(sender, senderEmail);
    await sender.locator('#org-name').fill(`Browser Team ${marker}`); await sender.locator('#create-org-form button').click();
    await sender.waitForFunction(name => document.querySelector('#organization').selectedOptions[0]?.textContent === name, `Browser Team ${marker}`);
    await sender.locator('#team-controls summary').click();
    await sender.locator('#member-email').fill(recipientEmail); await sender.locator('#member-role').selectOption('viewer'); await sender.locator('#member-form button').click();
    await sender.waitForFunction(address => document.querySelector('#members').textContent.includes(address), recipientEmail);
    await sender.locator('#sandbox-plan').selectOption('team'); await sender.locator('#sandbox-form button').click();
    await sender.waitForFunction(() => document.querySelector('#usage-summary').textContent.startsWith('team plan'));
    const fileName = '<img src=x onerror=alert(1)>.txt', bytes = Buffer.from(`Browser transfer ${marker}`);
    await sender.locator('#file').setInputFiles({ name: fileName, mimeType: 'text/plain', buffer: bytes });
    await sender.locator('#recipient').fill(recipientEmail); await sender.locator('#upload-form button').click();
    await sender.locator('#share-result').waitFor({ state: 'visible' });
    const share = await sender.locator('#share-link').inputValue(); assert.ok(share.includes('?transfer='));
    await sender.waitForFunction(() => [...document.querySelectorAll('.transfer')].some(row => row.textContent.includes('active')), undefined, { timeout: 90000 });
    assert.equal(await sender.locator('#files img').count(), 0);
    await signIn(recipient, recipientEmail);
    await recipient.locator('#organization').selectOption({ label: `Browser Team ${marker}` });
    await recipient.locator('#upload-form').waitFor({ state: 'hidden' });
    assert.equal(await recipient.locator('#team-controls').isVisible(), false);
    await recipient.locator('.transfer button', { hasText: 'Download' }).waitFor();
    const downloadEvent = recipient.waitForEvent('download'); await recipient.getByRole('button', { name: 'Download', exact: true }).click();
    const download = await downloadEvent; const downloaded = await fs.readFile(await download.path()); assert.deepEqual(downloaded, bytes);
    const auditEvent = sender.waitForEvent('download'); await sender.locator('#audit-export').click();
    const exported = await auditEvent; const audit = await fs.readFile(await exported.path(), 'utf8'); assert.match(audit, /UPLOAD/);
    await fs.mkdir('test-results', { recursive: true }); await sender.screenshot({ path: 'test-results/pilot-workspace.png', fullPage: true });
    await sender.getByRole('button', { name: 'Revoke and delete' }).click();
    await sender.waitForFunction(() => document.querySelector('#status').textContent.startsWith('Access revoked'));
    await recipient.locator('#refresh').click(); await recipient.getByRole('button', { name: 'Download', exact: true }).waitFor({ state: 'hidden' });
    assert.deepEqual(errors, []);
    console.log('PASS: browser sign-in, workspace creation, viewer role, sandbox plan, safe filename rendering, recipient download, audit export and revocation');
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
