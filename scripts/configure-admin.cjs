const fs = require('node:fs/promises');
const crypto = require('node:crypto');
async function main() {
  const [input, option] = process.argv.slice(2), email = input?.trim().toLowerCase();
  if (!email || email.length > 254 || !/^[a-z\d._+-]+@[a-z\d](?:[a-z\d-]*[a-z\d])?(?:\.[a-z\d](?:[a-z\d-]*[a-z\d])?)+$/i.test(email) || option !== undefined && option !== '--remove') throw new Error('Usage: node scripts/configure-admin.cjs operator@example.com [--remove]');
  const file = '.env.local';
  if ((await fs.lstat(file)).isSymbolicLink()) throw new Error('Use a regular .env.local file');
  const contents = await fs.readFile(file, 'utf8'), matches = [...contents.matchAll(/^PLATFORM_ADMIN_EMAILS=(.*)$/gm)];
  if (matches.length > 1) throw new Error('Remove duplicate PLATFORM_ADMIN_EMAILS entries first');
  const addresses = new Set((matches[0]?.[1] || '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean));
  if (option === '--remove') addresses.delete(email); else addresses.add(email);
  if (addresses.size > 20) throw new Error('At most 20 platform administrators may be configured');
  const line = `PLATFORM_ADMIN_EMAILS=${[...addresses].join(',')}`;
  const updated = matches.length ? contents.replace(/^PLATFORM_ADMIN_EMAILS=.*$/m, line) : `${contents}${contents.endsWith('\n') ? '' : '\n'}${line}\n`;
  const temporary = `${file}.admin-${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, updated, { flag: 'wx', mode: 0o600 });
    if (await fs.readFile(file, 'utf8') !== contents) throw new Error('Configuration changed. Retry the command.');
    await fs.rename(temporary, file);
  } finally { await fs.rm(temporary, { force: true }); }
  console.log('Platform allowlist updated. Restart the app to apply it. Existing keys were preserved.');
}
main().catch(error => { console.error(error.code === 'ENOENT' ? 'Run node scripts/init-local.cjs first.' : error.message); process.exitCode = 1; });
