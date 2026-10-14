const $ = id => document.getElementById(id);
let token = null, identity = null, challenge = null;
let organization = null, organizations = [], refreshing = false;
let activeUpload = null;
const sharedId = new URL(location.href).searchParams.get('transfer');
const status = (message, error = false) => { $('status').textContent = message; $('status').dataset.error = String(error); };
async function api(url, options = {}) {
  const headers = new Headers(options.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (organization) headers.set('X-Organization-ID', organization);
  const response = await fetch(url, { ...options, headers });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    if (response.status === 401 && token) signedOut();
    throw new Error(body.error || 'The request failed');
  }
  return response;
}
const post = async (url, body) => (await api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
function signedOut() { token = null; identity = null; organization = null; organizations = []; $('signin').hidden = false; $('workspace').hidden = true; $('share-result').hidden = true; $('files').replaceChildren(); }
async function busy(form, action) {
  const buttons = [...form.querySelectorAll('button')]; buttons.forEach(button => button.disabled = true);
  try { await action(); } catch (error) { status(error.name === 'AbortError' ? 'Upload cancelled. Refresh transfers to check whether it had already completed.' : error.message, true); }
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
    await loadOrganizations(); status('Signed in. You can now send and receive files.'); await refresh();
  });
});
$('upload-form').addEventListener('submit', event => {
  event.preventDefault(); busy(event.currentTarget, async () => {
    const file = $('file').files[0];
    if (!file || file.size > 10 * 1024 * 1024) throw new Error('Choose a file no larger than 10 MB');
    const body = new FormData(); body.append('file', file); body.append('recipient', $('recipient').value); body.append('expiryHours', $('expiry').value);
    status('Uploading and encrypting your file…');
    activeUpload = new AbortController(); $('cancel-upload').hidden = false; $('upload-progress').hidden = false;
    let result;
    try { result = await (await api('/api/upload', { method: 'POST', headers: { 'X-File-Size': String(file.size) }, body, signal: activeUpload.signal })).json(); }
    finally { activeUpload = null; $('cancel-upload').hidden = true; $('upload-progress').hidden = true; }
    $('share-link').value = result.shareUrl; $('share-result').hidden = false; $('file').value = '';
    status('File encrypted and queued for malware scanning. The recipient will be emailed when it is ready.'); await refresh();
  });
});
async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
  const usage = await (await api('/api/usage')).json();
  $('usage-summary').textContent = `${usage.plan} plan · ${(usage.usedBytes / 1024 / 1024).toFixed(1)} / ${(usage.limits.storageBytes / 1024 / 1024).toFixed(0)} MB · ${usage.fileCount} / ${usage.limits.files} files`;
  const { files } = await (await api('/api/files')).json();
  $('files').replaceChildren();
  if (!files.length) { $('files').textContent = 'No transfers yet.'; return; }
  files.sort((a, b) => Number(b._id === sharedId) - Number(a._id === sharedId));
  for (const file of files) {
    const item = document.createElement('article'); item.className = 'transfer';
    const title = document.createElement('strong'); title.textContent = file.name;
    const details = document.createElement('p');
    const expired = new Date(file.expiresAt) <= new Date();
    details.textContent = `${file.owner === identity ? `To ${file.recipient}` : `From ${file.owner}`} · ${(file.size / 1024).toFixed(1)} KB · ${file.scanResult === 'infected' ? 'blocked by malware policy' : file.status === 'active' && expired ? 'expired' : file.status} · expires ${new Date(file.expiresAt).toLocaleString()} · ${file.downloads} downloads`;
    item.append(title, details);
    if (file.status === 'active' && !expired) {
      const download = document.createElement('button'); download.textContent = 'Download';
      download.addEventListener('click', () => busy(item, async () => {
        const response = await api(`/api/file/${file._id}/download`), blob = await response.blob();
        const url = URL.createObjectURL(blob), anchor = document.createElement('a'); anchor.href = url; anchor.download = file.name; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
        status('Download complete.'); await refresh();
      })); item.append(download);
    }
      const current = organizations.find(org => org._id === organization), role = current?.members.find(member => member.email === identity)?.role;
      if (file.orgId === organization && role !== 'viewer' && (file.owner === identity || ['owner', 'admin'].includes(role)) && ['active', 'quarantined', 'blocked'].includes(file.status)) {
        const revoke = document.createElement('button'); revoke.className = 'secondary'; revoke.textContent = 'Revoke and delete';
        revoke.addEventListener('click', () => busy(item, async () => {
          await api(`/api/file/${file._id}`, { method: 'DELETE' }); status('Access revoked. File deletion is queued.'); await refresh();
        })); item.append(revoke);
      }
    $('files').append(item);
  }
  } finally { refreshing = false; }
}
async function loadOrganizations() {
  const response = await (await api('/api/organizations')).json(); organizations = response.organizations;
  if (!organizations.some(org => org._id === organization)) organization = organizations[0]?._id;
  $('organization').replaceChildren();
  for (const org of organizations) {
    const option = document.createElement('option'); option.value = org._id; option.textContent = org.name; $('organization').append(option);
  }
  $('organization').value = organization;
  const current = organizations.find(org => org._id === organization), role = current?.members.find(member => member.email === identity)?.role;
  $('team-controls').hidden = !['owner', 'admin'].includes(role); $('sandbox-form').hidden = role !== 'owner';
  $('upload-form').hidden = role === 'viewer' || current?.status !== 'active';
  $('members').replaceChildren();
  for (const member of current?.members || []) {
    const row = document.createElement('p'); row.textContent = `${member.email} · ${member.role}`;
    if (role === 'owner' && member.role !== 'owner') {
      const remove = document.createElement('button'); remove.className = 'secondary'; remove.textContent = 'Remove';
      remove.addEventListener('click', () => busy($('team-controls'), async () => {
        await api(`/api/organizations/${organization}/members/${encodeURIComponent(member.email)}`, { method: 'DELETE' });
        await loadOrganizations(); await refresh(); status('Member access removed.');
      })); row.append(' ', remove);
    }
    $('members').append(row);
  }
}
$('organization').addEventListener('change', () => busy($('workspace'), async () => { organization = $('organization').value; $('share-result').hidden = true; await loadOrganizations(); await refresh(); }));
$('create-org-form').addEventListener('submit', event => { event.preventDefault(); busy(event.currentTarget, async () => {
  const result = await post('/api/organizations', { name: $('org-name').value }); organization = result.organization._id; $('org-name').value = ''; await loadOrganizations(); await refresh(); status('Workspace created.');
}); });
$('member-form').addEventListener('submit', event => { event.preventDefault(); busy(event.currentTarget, async () => {
  await api(`/api/organizations/${organization}/members`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: $('member-email').value, role: $('member-role').value }) });
  await loadOrganizations(); status('Membership updated. The member can sign in with that email.');
}); });
$('sandbox-form').addEventListener('submit', event => { event.preventDefault(); busy(event.currentTarget, async () => {
  await post('/api/billing/sandbox/events', { eventId: crypto.randomUUID(), plan: $('sandbox-plan').value, status: 'active' }); await loadOrganizations(); await refresh(); status('Sandbox plan updated. No payment was collected.');
}); });
$('audit-export').addEventListener('click', () => busy($('team-controls'), async () => {
  const response = await api('/api/audit/export'); const url = URL.createObjectURL(await response.blob());
  const link = document.createElement('a'); link.href = url; link.download = 'audit.ndjson'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  status('Activity exported.');
}));
setInterval(() => { if (token && !$('workspace').hidden) refresh().catch(error => status(error.message, true)); }, 5000);
$('refresh').addEventListener('click', () => busy($('workspace'), refresh));
$('logout').addEventListener('click', () => busy($('workspace'), async () => { await post('/api/logout', {}); signedOut(); status('Signed out.'); }));
$('copy').addEventListener('click', () => busy($('share-result'), async () => { await navigator.clipboard.writeText($('share-link').value); status('Link copied.'); }));
$('cancel-upload').addEventListener('click', () => activeUpload?.abort());
fetch('/ready').then(response => status(response.ok ? 'Ready. Sign in to start a transfer.' : 'The application is unavailable.', !response.ok)).catch(() => status('Could not connect to the application.', true));
