const fs = require('node:fs');
const crypto = require('node:crypto');
try {
  fs.writeFileSync('.env.local', `ENCRYPTION_KEY=${crypto.randomBytes(32).toString('hex')}\nOTP_SECRET=${crypto.randomBytes(32).toString('hex')}\n`, { flag: 'wx', mode: 0o600 });
  console.log('Created .env.local with independent local keys. Keep it to decrypt existing uploads.');
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
  console.log('.env.local already exists; existing keys preserved.');
}
