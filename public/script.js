const $ = id => document.getElementById(id);
let token = null, identity = null, challenge = null;
const sharedId = new URL(location.href).searchParams.get('transfer');
const status = (message, error = false) => { $('status').textContent = message; $('status').dataset.error = String(error); };
async function api(url, options = {}) {
  const headers = new Headers(options.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const response = await fetch(url, { ...options, headers });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    if (response.status === 401 && token) signedOut();
    throw new Error(body.error || 'The request failed');
  }
  return response;
}
const post = async (url, body) => (await api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
function signedOut() { token = null; identity = null; $('signin').hidden = false; $('workspace').hidden = true; $('share-result').hidden = true; $('files').replaceChildren(); }
async function busy(form, action) {
  const buttons = [...form.querySelectorAll('button')]; buttons.forEach(button => button.disabled = true);
  try { await action(); } catch (error) { status(error.message, true); }
  finally { buttons.forEach(button => button.disabled = false); }
}
$('request-form').addEventListener('submit', event => {
  event.preventDefault(); busy(event.currentTarget, async () => {
    const result = await post('/api/request-otp', { email: $('email').value });
    challenge = result.sessionId; $('verify-form').hidden = false; $('code').focus(); status('Code sent. Check your email inbox.');
  });
});
$('verify-form').addEventListener('submit', event => {
  event.preventDefault(); busy(event.currentTarget, async () => {
    const result = await post('/api/verify-otp', { sessionId: challenge, otp: $('code').value });
    token = result.token; identity = result.email; $('code').value = ''; $('verify-form').hidden = true;
    $('signin').hidden = true; $('workspace').hidden = false; $('identity').textContent = `Signed in as ${identity}`;
    if (sharedId) { $('shared-message').hidden = false; $('shared-message').textContent = 'A transfer link brought you here. Your available files are listed below.'; }
    status('Signed in. You can now send and receive files.'); await refresh();
  });
});
$('upload-form').addEventListener('submit', event => {
  event.preventDefault(); busy(event.currentTarget, async () => {
    const file = $('file').files[0];
    if (!file || file.size > 10 * 1024 * 1024) throw new Error('Choose a file no larger than 10 MB');
    const body = new FormData(); body.append('file', file); body.append('recipient', $('recipient').value); body.append('expiryHours', $('expiry').value);
    status('Uploading and encrypting your file…');
    const result = await (await api('/api/upload', { method: 'POST', body })).json();
    $('share-link').value = result.shareUrl; $('share-result').hidden = false; $('file').value = '';
    status(result.notified ? 'File shared. The recipient has been emailed.' : 'File saved. Email delivery failed; copy and send the link.'); await refresh();
  });
});
async function refresh() {
  const { files } = await (await api('/api/files')).json();
  $('files').replaceChildren();
  if (!files.length) { $('files').textContent = 'No transfers yet.'; return; }
  files.sort((a, b) => Number(b._id === sharedId) - Number(a._id === sharedId));
  for (const file of files) {
    const item = document.createElement('article'); item.className = 'transfer';
    const title = document.createElement('strong'); title.textContent = file.name;
    const details = document.createElement('p');
    const expired = new Date(file.expiresAt) <= new Date();
    details.textContent = `${file.owner === identity ? `To ${file.recipient}` : `From ${file.owner}`} · ${(file.size / 1024).toFixed(1)} KB · ${file.status === 'active' && expired ? 'expired' : file.status} · expires ${new Date(file.expiresAt).toLocaleString()} · ${file.downloads} downloads`;
    item.append(title, details);
    if (file.status === 'active' && !expired) {
      const download = document.createElement('button'); download.textContent = 'Download';
      download.addEventListener('click', () => busy(item, async () => {
        const response = await api(`/api/file/${file._id}/download`), blob = await response.blob();
        const url = URL.createObjectURL(blob), anchor = document.createElement('a'); anchor.href = url; anchor.download = file.name; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
        status('Download complete.'); await refresh();
      })); item.append(download);
      if (file.owner === identity) {
        const revoke = document.createElement('button'); revoke.className = 'secondary'; revoke.textContent = 'Revoke and delete';
        revoke.addEventListener('click', () => busy(item, async () => {
          await api(`/api/file/${file._id}`, { method: 'DELETE' }); status('Access revoked. File deletion is queued.'); await refresh();
        })); item.append(revoke);
      }
    }
    $('files').append(item);
  }
}
$('refresh').addEventListener('click', () => busy($('workspace'), refresh));
$('logout').addEventListener('click', () => busy($('workspace'), async () => { await post('/api/logout', {}); signedOut(); status('Signed out.'); }));
$('copy').addEventListener('click', () => busy($('share-result'), async () => { await navigator.clipboard.writeText($('share-link').value); status('Link copied.'); }));
fetch('/ready').then(response => status(response.ok ? 'Ready. Sign in to start a transfer.' : 'The application is unavailable.', !response.ok)).catch(() => status('Could not connect to the application.', true));
