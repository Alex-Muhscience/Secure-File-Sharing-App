const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const errors = [];
for (const file of files) {
  if (/(^|\/)node_modules\//.test(file) || /(^|\/)\.env(?:\..*)?$/.test(file) && !file.endsWith('.env.example') || /(^|\/)(?:secrets|keyrings|backups|restore)\//.test(file)) errors.push(file);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile() || fs.statSync(file).size > 1024 * 1024) continue;
  const content = fs.readFileSync(file, 'utf8');
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(content) || /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/.test(content)) errors.push(file);
}
if (errors.length) { console.error('Unexpected secrets/runtime paths in tracked source:', [...new Set(errors)].join(', ')); process.exit(1); }
console.log(`Tracked-file secret check passed (${files.length} files); historical exposure still requires provider rotation.`);
