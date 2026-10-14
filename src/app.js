const express = require('express');
const multer = require('multer');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs/promises');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const email = value => typeof value === 'string' && value.length <= 254 && /^[a-z\d.!#$%&'*+/=?^_`{|}~-]+@[a-z\d](?:[a-z\d-]*[a-z\d])?(?:\.[a-z\d](?:[a-z\d-]*[a-z\d])?)+$/i.test(value) ? value.toLowerCase() : null;
const idValid = value => typeof value === 'string' && /^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/.test(value);
function createApp({ config, db, storage, mail }) {
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" });
    if (req.path.startsWith('/api')) res.set('Cache-Control', 'no-store');
    next();
  });
  app.use(express.json({ limit: '16kb' }));
  const challenges = db.collection('challenges'), sessions = db.collection('sessions'), transfers = db.collection('transfers');
  const audit = (action, actor, transferId) => db.collection('audit').insertOne({ action, actor, transferId, at: new Date() });
  const digest = (id, code) => crypto.createHmac('sha256', config.otpSecret).update(`${id}:${code}`).digest('hex');
  const limit = (scope, max, windowMs) => async (req, res, next) => {
    const now = Date.now();
    const record = await db.collection('limits').findOneAndUpdate(
      { _id: hash(`${scope}:${req.ip}:${Math.floor(now / windowMs)}`) },
      { $inc: { count: 1 }, $setOnInsert: { expiresAt: new Date(now + 2 * windowMs) } },
      { upsert: true, returnDocument: 'after' });
    if (record.count > max) return res.status(429).json({ error: 'Too many requests. Try again later.' });
    next();
  };
  app.get('/health', (req, res) => res.json({ status: 'alive' }));
  app.get('/ready', async (req, res) => {
    try { await db.command({ ping: 1 }); await storage.ready(); res.json({ status: 'ready' }); }
    catch { res.status(503).json({ status: 'unavailable' }); }
  });
  app.use('/api', limit('api', 200, 60000));
  app.post('/api/request-otp', limit('otp', 10, 900000), async (req, res) => {
    const address = email(req.body.email);
    if (!address) return res.status(400).json({ error: 'Enter a valid email address' });
    const id = crypto.randomUUID(), code = crypto.randomInt(0, 1000000).toString().padStart(6, '0'), now = new Date();
    try {
      await challenges.findOneAndUpdate({ _id: address, nextSend: { $lte: now } }, { $set: {
        id, digest: digest(id, code), attempts: 0, used: false,
        expiresAt: new Date(+now + 600000), nextSend: new Date(+now + 60000),
      } }, { upsert: true });
    } catch (error) {
      if (error.code === 11000) return res.status(429).json({ error: 'Wait one minute before requesting another code' });
      throw error;
    }
    try { await mail.sendMail({ from: config.from, to: address, subject: 'Your Secure Transfer code', text: `Your sign-in code is ${code}. It expires in 10 minutes. If you did not request this, ignore this email.` }); }
    catch (error) { await challenges.deleteOne({ _id: address, id }); return res.status(503).json({ error: 'Unable to deliver verification email' }); }
    res.json({ success: true, sessionId: id });
  });
  app.post('/api/verify-otp', limit('verify', 30, 900000), async (req, res) => {
    const { sessionId, otp } = req.body;
    if (!idValid(sessionId) || typeof otp !== 'string' || !/^\d{6}$/.test(otp)) return res.status(400).json({ error: 'Invalid verification request' });
    const challenge = await challenges.findOneAndUpdate({ id: sessionId, used: false, attempts: { $lt: 5 }, expiresAt: { $gt: new Date() } }, { $inc: { attempts: 1 } }, { returnDocument: 'after' });
    if (!challenge || !crypto.timingSafeEqual(Buffer.from(challenge.digest, 'hex'), Buffer.from(digest(sessionId, otp), 'hex'))) return res.status(401).json({ error: 'Invalid or expired code' });
    const consumed = await challenges.updateOne({ id: sessionId, used: false, expiresAt: { $gt: new Date() } }, { $set: { used: true }, $unset: { digest: '' } });
    if (!consumed.modifiedCount) return res.status(401).json({ error: 'Code has already been used' });
    const token = crypto.randomBytes(32).toString('hex');
    await sessions.insertOne({ _id: hash(token), email: challenge._id, expiresAt: new Date(Date.now() + 3600000) });
    await audit('SIGN_IN', challenge._id);
    res.json({ success: true, token, email: challenge._id });
  });
  app.use('/api', async (req, res, next) => {
    const token = req.get('Authorization')?.match(/^Bearer ([a-f\d]{64})$/)?.[1];
    const session = token && await sessions.findOne({ _id: hash(token), expiresAt: { $gt: new Date() } });
    if (!session) return res.status(401).json({ error: 'Sign in to continue' });
    req.identity = session.email; req.sessionHash = session._id; next();
  });
  app.post('/api/logout', async (req, res) => { await sessions.deleteOne({ _id: req.sessionHash }); res.json({ success: true }); });
  let active = 0;
  const capacity = (req, res, next) => {
    if (active >= config.concurrency) return res.status(503).json({ error: 'Transfer capacity reached. Try again shortly.' });
    active++; let released = false;
    const release = () => { if (!released) { active--; released = true; } };
    // Upload middleware continues after disconnect; release when processing settles.
    req.releaseCapacity = release;
    res.once('finish', release);
    next();
  };
  const upload = multer({ storage, limits: { fileSize: config.maxSize, files: 1, fields: 3, fieldSize: 1024, parts: 4 } }).single('file');
  app.post('/api/upload', capacity, (req, res, next) => upload(req, res, error => {
    if (error) { req.releaseCapacity(); return next(error); } next();
  }), async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Choose a file' });
    let persisted = false;
    try {
      const recipient = email(req.body.recipient), hours = Number(req.body.expiryHours || 24);
      if (!recipient || !Number.isInteger(hours) || hours < 1 || hours > 168) {
        await storage.remove(req.file.objectId);
        return res.status(400).json({ error: 'Provide a recipient and an expiry between 1 and 168 hours' });
      }
      const name = path.basename(req.file.originalname.replace(/\\/g, '/')).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 200) || 'download';
      const file = { _id: crypto.randomUUID(), owner: req.identity, recipient, name,
        objectId: req.file.objectId, size: req.file.size, iv: req.file.iv, tag: req.file.tag, version: 1,
        status: 'active', downloads: 0, createdAt: new Date(), expiresAt: new Date(Date.now() + hours * 3600000) };
      await transfers.insertOne(file); persisted = true;
      await audit('UPLOAD', req.identity, file._id);
      const shareUrl = `${config.baseUrl}/?transfer=${file._id}`;
      let notified = true;
      try { await mail.sendMail({ from: config.from, to: recipient, subject: 'A file has been shared with you', text: `${req.identity} shared ${name}. Sign in with this email to download it: ${shareUrl}\nExpires: ${file.expiresAt.toISOString()}` }); }
      catch { notified = false; }
      res.status(201).json({ success: true, fileId: file._id, shareUrl, notified });
    } finally { if (!persisted) await storage.remove(req.file.objectId); req.releaseCapacity(); }
  });
  app.get('/api/files', async (req, res) => {
    const files = await transfers.find({ $or: [{ owner: req.identity }, { recipient: req.identity }], status: { $ne: 'deleted' } }, { projection: { objectId: 0, iv: 0, tag: 0 } }).sort({ createdAt: -1 }).limit(100).toArray();
    res.json({ files });
  });
  app.get('/api/file/:id/download', capacity, async (req, res) => {
    try {
      const file = idValid(req.params.id) && await transfers.findOne({ _id: req.params.id, $or: [{ owner: req.identity }, { recipient: req.identity }], status: 'active', expiresAt: { $gt: new Date() } });
      if (!file) return res.status(404).json({ error: 'File unavailable' });
      const bytes = await storage.decrypt(file);
      // Recheck access after reading/authenticating, in case the owner revoked it.
      const access = await transfers.updateOne({ _id: file._id, status: 'active', expiresAt: { $gt: new Date() } }, { $inc: { downloads: 1 } });
      if (!access.modifiedCount) return res.status(404).json({ error: 'File unavailable' });
      await audit('DOWNLOAD', req.identity, file._id);
      res.set({ 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(file.name).replace(/'/g, '%27')}` });
      res.send(bytes);
    } finally { req.releaseCapacity(); }
  });
  app.delete('/api/file/:id', async (req, res) => {
    const file = idValid(req.params.id) && await transfers.findOneAndUpdate({ _id: req.params.id, owner: req.identity, status: { $in: ['active', 'deleting'] } }, { $set: { status: 'deleting' } }, { returnDocument: 'after' });
    if (!file) return res.status(404).json({ error: 'File unavailable' });
    await audit('REVOKE', req.identity, file._id);
    // Persist the tombstone first; the worker retries object deletion after failures.
    res.json({ success: true });
  });
  app.use(express.static(path.join(__dirname, '../public'), { dotfiles: 'deny' }));
  app.use((req, res) => res.status(404).json({ error: 'Not found' }));
  app.use((error, req, res, next) => {
    req.releaseCapacity?.();
    if (res.headersSent) return next(error);
    const status = error instanceof multer.MulterError ? 413 : error.type === 'entity.too.large' ? 413 : error instanceof SyntaxError && 'body' in error ? 400 : 500;
    if (status === 500) console.error('Request failed:', error.name);
    res.status(status).json({ error: status === 413 ? 'Upload exceeds the allowed limits' : status === 400 ? 'Invalid JSON' : 'Request could not be completed' });
  });
  let cleaning = false;
  async function cleanup() {
    if (cleaning) return; cleaning = true;
    try {
      await transfers.updateMany({ status: 'active', expiresAt: { $lte: new Date() } }, { $set: { status: 'deleting' } });
      for await (const file of transfers.find({ status: 'deleting' })) {
        await storage.remove(file.objectId);
        await transfers.updateOne({ _id: file._id, status: 'deleting' }, { $set: { status: 'deleted', deletedAt: new Date() }, $unset: { iv: '', tag: '' } });
      }
      // Recover interrupted uploads after a grace period; live uploads are bounded.
      for (const name of await fs.readdir(config.storage)) {
        if (!/^[a-f\d-]{36}\.enc$/.test(name)) continue;
        const objectId = name.slice(0, -4), stat = await fs.stat(storage.objectPath(objectId)).catch(() => null);
        if (stat && stat.mtimeMs < Date.now() - 3600000 && !await transfers.findOne({ objectId })) await storage.remove(objectId);
      }
    } finally { cleaning = false; }
  }
  return { app, cleanup };
}
module.exports = { createApp, email, idValid };
