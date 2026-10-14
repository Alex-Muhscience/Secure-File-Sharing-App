const path = require('node:path');
function loadConfig(env = process.env) {
  for (const name of ['ENCRYPTION_KEY', 'OTP_SECRET']) {
    if (!/^[a-f\d]{64}$/i.test(env[name] || '')) throw new Error(`${name} must contain 64 hex characters`);
  }
  if (env.ENCRYPTION_KEY.toLowerCase() === env.OTP_SECRET.toLowerCase()) throw new Error('Use independent encryption and OTP keys');
  const keys = Object.assign(Object.create(null), { legacy: Buffer.from(env.ENCRYPTION_KEY, 'hex') });
  if (env.ENCRYPTION_KEYS) {
    let entries;
    try { entries = JSON.parse(env.ENCRYPTION_KEYS); } catch { throw new Error('Invalid ENCRYPTION_KEYS JSON'); }
    if (!entries || Array.isArray(entries) || typeof entries !== 'object') throw new Error('Invalid ENCRYPTION_KEYS');
    for (const [id, value] of Object.entries(entries)) {
      if (!/^[a-z\d_-]{1,40}$/i.test(id) || !/^[a-f\d]{64}$/i.test(value)) throw new Error('Invalid keyring entry');
      if (id === 'legacy' && value.toLowerCase() !== env.ENCRYPTION_KEY.toLowerCase()) throw new Error('Legacy key must match ENCRYPTION_KEY');
      if (value.toLowerCase() === env.OTP_SECRET.toLowerCase()) throw new Error('Use independent encryption and OTP keys');
      keys[id] = Buffer.from(value, 'hex');
    }
  }
  const keyId = env.ENCRYPTION_KEY_ID || 'legacy';
  if (!Object.hasOwn(keys, keyId)) throw new Error('Current encryption key ID is absent from the keyring');
  const storageDriver = env.STORAGE_DRIVER || 'filesystem';
  if (!['filesystem', 's3'].includes(storageDriver)) throw new Error('Invalid STORAGE_DRIVER');
  let s3 = null;
  if (storageDriver === 's3' || env.S3_ENDPOINT) {
    for (const name of ['S3_ENDPOINT', 'S3_BUCKET', 'S3_REGION', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY']) {
      if (typeof env[name] !== 'string' || !env[name]) throw new Error(`${name} is required for S3 storage`);
    }
    let endpoint;
    try { endpoint = new URL(env.S3_ENDPOINT); } catch { throw new Error('Invalid S3_ENDPOINT'); }
    if (!['https:', 'http:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('Invalid S3_ENDPOINT');
    if (!/^[a-z\d][a-z\d.-]{1,61}[a-z\d]$/.test(env.S3_BUCKET)) throw new Error('Invalid S3_BUCKET');
    const prefix = env.S3_PREFIX || 'objects/';
    if (!/^[a-z\d_-]{1,80}\/$/i.test(prefix)) throw new Error('Invalid S3_PREFIX');
    s3 = { endpoint: endpoint.toString(), bucket: env.S3_BUCKET, region: env.S3_REGION, prefix,
      accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY };
  }
  if (!env.MONGO_URI || !env.SMTP_HOST) throw new Error('MONGO_URI and SMTP_HOST are required');
  const number = (name, fallback, max) => {
    const value = Number(env[name] || fallback);
    if (!Number.isInteger(value) || value < 1 || value > max) throw new Error(`Invalid ${name}`);
    return value;
  };
  const baseUrl = new URL(env.APP_URL || 'http://localhost:3081');
  if (!['http:', 'https:'].includes(baseUrl.protocol)) throw new Error('Invalid APP_URL');
  return {
    port: number('PORT', 3000, 65535), host: env.HOST || '0.0.0.0',
    mongoUri: env.MONGO_URI, key: Buffer.from(env.ENCRYPTION_KEY, 'hex'),
    keys, keyId,
    storageDriver, s3,
    otpSecret: Buffer.from(env.OTP_SECRET, 'hex'), storage: path.resolve(env.STORAGE_DIR || './data/objects'),
    maxSize: number('MAX_FILE_SIZE', 10 * 1024 * 1024, 25 * 1024 * 1024),
    concurrency: number('MAX_TRANSFERS', 4, 16), baseUrl: baseUrl.origin,
    scannerHost: env.SCANNER_HOST || '', scannerPort: number('SCANNER_PORT', 3310, 65535),
    billingSandbox: env.BILLING_SANDBOX === 'true', workerOnly: env.WORKER_ONLY === 'true',
    smtp: { host: env.SMTP_HOST, port: number('SMTP_PORT', 1025, 65535),
      connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000,
      disableFileAccess: true, disableUrlAccess: true,
      secure: env.SMTP_SECURE === 'true',
      ...(env.SMTP_USER ? { auth: { user: env.SMTP_USER, pass: env.SMTP_PASS } } : {}) },
    from: env.EMAIL_FROM || 'Secure Transfer <transfer@localhost>',
  };
}
module.exports = { loadConfig };
