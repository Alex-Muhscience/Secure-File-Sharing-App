const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const envFile = '.env.s3';
if (!fs.existsSync(envFile)) {
  fs.writeFileSync(envFile, [
    'STORAGE_DRIVER=s3', 'S3_ENDPOINT=http://garage:3900', 'S3_REGION=garage', 'S3_BUCKET=secure-transfer',
    `S3_ACCESS_KEY_ID=GK${crypto.randomBytes(16).toString('hex')}`, `S3_SECRET_ACCESS_KEY=${crypto.randomBytes(32).toString('hex')}`,
    `GARAGE_CONFIG_GID=${process.getgid()}`, '',
  ].join('\n'), { flag: 'wx', mode: 0o600 });
  console.log('Created private local S3 credentials in .env.s3.');
} else console.log('.env.s3 already exists; S3 credentials preserved.');
fs.mkdirSync('secrets', { recursive: true, mode: 0o700 });
const configPath = path.join('secrets', 'garage.toml');
if (!fs.existsSync(configPath)) {
  fs.writeFileSync(configPath, [
    'metadata_dir = "/var/lib/garage/meta"', 'data_dir = "/var/lib/garage/data"', 'db_engine = "sqlite"', 'replication_factor = 1',
    'rpc_bind_addr = "0.0.0.0:3901"', 'rpc_public_addr = "garage:3901"', `rpc_secret = "${crypto.randomBytes(32).toString('hex')}"`,
    '[s3_api]', 's3_region = "garage"', 'api_bind_addr = "0.0.0.0:3900"', '',
  ].join('\n'), { flag: 'wx', mode: 0o640 });
  console.log('Created private Garage configuration.');
} else console.log('Garage configuration already exists; RPC secret preserved.');
