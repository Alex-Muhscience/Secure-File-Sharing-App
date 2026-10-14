const fs = require('node:fs');
const crypto = require('node:crypto');
try {
  fs.writeFileSync('.env.local', `ENCRYPTION_KEY=${crypto.randomBytes(32).toString('hex')}\nOTP_SECRET=${crypto.randomBytes(32).toString('hex')}\n`, { flag: 'wx', mode: 0o600 });
  console.log('Created .env.local with independent local keys. Keep it to decrypt existing uploads.');
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  console.log('.env.local already exists; existing keys preserved.');
}
const contents = fs.readFileSync('.env.local', 'utf8');
if (!/^BACKUP_KEY=/m.test(contents)) {
  fs.appendFileSync('.env.local', `${contents.endsWith('\n') ? '' : '\n'}BACKUP_KEY=${crypto.randomBytes(32).toString('hex')}\n`);
  fs.chmodSync('.env.local', 0o600);
  console.log('Added an independent backup key; existing keys preserved.');
}
