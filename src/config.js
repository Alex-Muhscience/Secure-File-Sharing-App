const path = require('node:path');
function loadConfig(env = process.env) {
  for (const name of ['ENCRYPTION_KEY', 'OTP_SECRET']) {
    if (!/^[a-f\d]{64}$/i.test(env[name] || '')) throw new Error(`${name} must contain 64 hex characters`);
  }
  if (env.ENCRYPTION_KEY === env.OTP_SECRET) throw new Error('Use independent encryption and OTP keys');
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
    otpSecret: Buffer.from(env.OTP_SECRET, 'hex'), storage: path.resolve(env.STORAGE_DIR || './data/objects'),
    maxSize: number('MAX_FILE_SIZE', 10 * 1024 * 1024, 25 * 1024 * 1024),
    concurrency: number('MAX_TRANSFERS', 4, 16), baseUrl: baseUrl.origin,
    smtp: { host: env.SMTP_HOST, port: number('SMTP_PORT', 1025, 65535),
      connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000,
      disableFileAccess: true, disableUrlAccess: true,
      secure: env.SMTP_SECURE === 'true',
      ...(env.SMTP_USER ? { auth: { user: env.SMTP_USER, pass: env.SMTP_PASS } } : {}) },
    from: env.EMAIL_FROM || 'Secure Transfer <transfer@localhost>',
  };
}
module.exports = { loadConfig };
