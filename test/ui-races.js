const assert = require('node:assert/strict');
const path = require('node:path');
const express = require('express');
const { chromium } = require('playwright');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
async function main() {
  const app = express(); app.use(express.static(path.join(__dirname, '../public')));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext(), page = await context.newPage();
    const oldVerification = deferred(), verifying = deferred(), exportGate = deferred(), exporting = deferred(), compressionGate = deferred(), inspectingCompression = deferred();
    const first = 'personal_fixture', second = 'workspace_fixture', email = 'new@example.com';
    let holdVerification = true, heldExport = false, compressionPolls = 0;
    const orgs = [first, second].map((_id, i) => ({ _id, name: i ? 'Second workspace' : 'Personal workspace', owner: email, members: [{ email, role: 'owner' }], plan: 'pilot', status: 'active', usedBytes: 0, fileCount: 0, limits: { storageBytes: 1000, files: 100, seats: 5 } }));
    await page.route('**/api/**', async route => {
      const request = route.request(), endpoint = new URL(request.url()).pathname;
      const send = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
      if (endpoint === '/api/config') return send({ maxFileSize: 1000, billingSandbox: false, resumable: { enabled: false } });
      if (endpoint === '/api/request-otp') return send({ sessionId: request.postDataJSON().email });
      if (endpoint === '/api/verify-otp') {
        if (holdVerification) { verifying.resolve(); await oldVerification.promise; }
        return send({ token: '1'.repeat(64), email: request.postDataJSON().sessionId });
      }
      if (endpoint === '/api/organizations') return send({ organizations: orgs });
      if (endpoint === '/api/me') return send({ email, platformAdmin: false });
      if (endpoint === '/api/files') return send({ files: [] });
      if (endpoint === '/api/usage') return send({ plan: 'pilot', limits: orgs[0].limits, usedBytes: 0, fileCount: 0 });
      if (endpoint === '/api/operations') return send({ workerAvailable: true, transfers: {}, pendingNotifications: 0 });
      if (endpoint === '/api/file/previous-compression/compression') {
        inspectingCompression.resolve(); await compressionGate.promise;
        return send({ error: 'Previous compression private error' }, 503);
      }
      if (endpoint === '/api/file/retry-compression/compression') {
        if (compressionPolls++ === 0) return send({error:'Status temporarily unavailable'},503);
        return send({fileId:'retry-compression',name:'records.txt',status:'active',purpose:'send',profile:'documents',exportFormat:'gzip',originalBytes:4,storedBytes:4,codecCounts:[],exports:{}});
      }
      if (endpoint === '/api/audit/export') {
        if (!heldExport) { heldExport = true; exporting.resolve(); await exportGate.promise; return send({ error: 'Previous workspace private error' }, 503); }
        return route.fulfill({ status: 200, contentType: 'application/x-ndjson', body: '{}\n' });
      }
      return send({ error: 'Unexpected fixture request' }, 404);
    });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    if (process.env.UI_RACE_ONLY !== 'actions') {
    await page.locator('#email').fill('old@example.com'); await page.locator('#request-form button[type=submit]').click();
    await page.locator('#code').fill('123456'); await page.locator('#verify-form button[type=submit]').click(); await verifying.promise;
    await page.locator('#change-email').click(); await page.locator('#email').fill(email);
    const oldResponse = page.waitForResponse(response => response.url().endsWith('/api/verify-otp'));
    oldVerification.resolve(); await oldResponse;
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.waitForFunction(() => document.querySelector('#verify-form').getAttribute('aria-busy') !== 'true');
    assert.equal(await page.locator('#workspace').isVisible(), false, 'A superseded verification cannot activate the old account');
    assert.equal(await page.locator('#request-form').isVisible(), true);
    }
    holdVerification = false;
    await page.locator('#email').fill(email);
    await page.locator('#request-form button[type=submit]').click(); await page.locator('#code').fill('123456'); await page.locator('#verify-form button[type=submit]').click();
    await page.locator('#workspace').waitFor({ state: 'visible' }); await page.locator('#organization option').first().waitFor({ state: 'attached' });
    await page.locator('#nav-settings').click();
    await page.locator('#audit-export').click(); await exporting.promise;
    await page.locator('#organization').selectOption(second);
    // Start a new action using the same control while the previous workspace response is pending.
    const download = page.waitForEvent('download'); download.catch(() => {});
    await page.locator('#audit-export').click({ timeout: 2000 }); await download;
    const staleResponse = page.waitForResponse(response => response.url().endsWith('/api/audit/export') && response.status() === 503);
    exportGate.resolve(); await staleResponse;
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.doesNotMatch(await page.locator('#status').textContent(), /Previous workspace private error/, 'A stale action error must not appear in the new context');
    assert.equal(await page.locator('#audit-export').isEnabled(), true);
    await page.evaluate(() => { compressionUI.show('previous-compression', document.querySelector('#new-compression')); });
    await inspectingCompression.promise;
    await page.evaluate(() => {
      compressionUI.context();
      compressionUI.open(document.querySelector('#new-compression'));
    });
    compressionGate.resolve();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await page.locator('#compression-actions').isVisible(), true);
    assert.equal(await page.locator('#compression-title').textContent(), 'What would you like to do?');
    assert.doesNotMatch(await page.locator('#compression-dialog').textContent(), /Previous compression private error/);
    for (const lostCompletion of process.env.UI_RACE_ONLY === 'format' ? [] : [false,true]) {
      compressionPolls = lostCompletion ? 1 : 0;
      await page.evaluate(lost => {
        compressionUI.context(); compressionUI.open(document.querySelector('#new-compression'));
        window.compressionRequests=[];
        resumable.send=async (file,settings,signal,hooks) => {
          window.compressionRequests.push(settings); hooks.session({uploadId:'retry-compression'});
          if(lost)throw new Error('Completion response lost');
          return {fileId:'retry-compression',wireSentBytes:4};
        };
      },lostCompletion);
      await page.locator('[data-compression-action="send"]').click();
      await page.locator('#compression-next').click();
      await page.locator('#compression-file').setInputFiles({name:'records.txt',mimeType:'text/plain',buffer:Buffer.from('data')});
      await page.locator('#compression-next').click();
      await page.locator('#compression-recipient').fill('alice@example.com');
      await page.locator('#compression-format').selectOption('gzip');
      await page.locator('#compression-next').click();
      await page.locator('#compression-submit').click();
      await page.locator('#compression-error').waitFor({state:'visible'});
      assert.equal(await page.locator('#compression-back').isDisabled(),true,'A saved job must not be attached to edited settings after a retry');
      assert.equal(await page.locator('#compression-recipient').isDisabled(),true);
      assert.equal(await page.locator('#compression-mode').isDisabled(),true);
      assert.equal(await page.locator('#compression-recipient').inputValue(),'alice@example.com');
      await page.locator('#compression-submit').click();
      await page.locator('#compression-result').waitFor({state:'visible'});
      assert.equal(await page.evaluate(()=>window.compressionRequests.length),1,'Retry polls the original job without sending to another recipient');
      await page.locator('#compression-done').click();
    }
    compressionPolls = 1;
    await page.evaluate(()=>{compressionUI.show('retry-compression',document.querySelector('#new-compression'));});
    await page.locator('#compression-result').waitFor({state:'visible'});
    assert.equal(await page.locator('#compression-format').inputValue(),'gzip','Reopened jobs retain the saved portable format');
    console.log('PASS: superseded sign-in cannot install an old identity; stale action failures cannot affect a newer workspace or reused control');
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
