const express = require('express');
const multer = require('multer');
const crypto = require('node:crypto');
const path = require('node:path');
const { Pilot } = require('./pilot');
const { organizationRoutes } = require('./organization-routes');
const { billingRoutes } = require('./billing');
const { analyticsRoutes } = require('./analytics');
const { platformRoutes } = require('./platform');
const { resumableRoutes } = require('./segments');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { Payments } = require('./payments');
const { createAudit, auditRoutes } = require('./audit');
const { Worker } = require('./worker');
const { Scanner } = require('./scanner');
const { byteRange } = require('./ranges');
const { compressionRoutes } = require('./compression-routes');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const email = value => typeof value === 'string' && value.length <= 254 && /^[a-z\d.!#$%&'*+/=?^_`{|}~-]+@[a-z\d](?:[a-z\d-]*[a-z\d])?(?:\.[a-z\d](?:[a-z\d-]*[a-z\d])?)+$/i.test(value) ? value.toLowerCase() : null;
const idValid = value => typeof value === 'string' && /^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/.test(value);
function createApp({ config, db, storage, mail, scanner = new Scanner(config), paymentGateway }) {
  storage.attach(db);
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" });
    if (req.path.startsWith('/api')) res.set('Cache-Control', 'no-store');
    next();
  });
  const challenges = db.collection('challenges'), sessions = db.collection('sessions'), transfers = db.collection('transfers');
  const audit = createAudit(db), pilot = new Pilot(db);
  const payments = new Payments({ config, db, gateway: paymentGateway });
  const worker = new Worker({ config, db, storage, mail, scanner, audit, payments });
  worker.pilot=pilot;
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
  payments.publicRoutes(app, limit('payment-callbacks', 60, 60000));
  app.use(express.json({ limit: '16kb' }));
  app.get('/health', (req, res) => res.json({ status: 'alive' }));
  app.get('/ready', async (req, res) => {
    try { await db.command({ ping: 1 }); await storage.ready(); res.json({ status: 'ready' }); }
    catch { res.status(503).json({ status: 'unavailable' }); }
  });
  const apiLimit = limit('api', 200, 60000), chunkLimit = limit('chunks', 2000, 60000);
  app.use('/api', (req, res, next) => /^\/uploads\/[^/]+\/chunks$/.test(req.path) ? chunkLimit(req, res, next) : apiLimit(req, res, next));
  app.get('/api/config', (req, res) => {
    const hostname = new URL(config.baseUrl).hostname;
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(hostname)||hostname.endsWith('.localhost');
    res.json({ maxFileSize: Math.min(config.maxSize, config.scanMaxSize), billingSandbox: config.billingSandbox, resumable: { enabled: true, chunkSize: config.chunkSize, uploadCodecs:['none','gzip','stp1'] },
      inboxUrl: local && config.smtp.host === 'mail' ? 'http://localhost:8025' : null });
  });
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
  app.post('/api/logout', async (req, res) => {
    const token = req.get('Authorization')?.match(/^Bearer ([a-f\d]{64})$/)?.[1];
    if (!token) return res.json({ success: true });
    const sessionHash = hash(token);
    await sessions.deleteOne({ _id: sessionHash });
    await db.collection('downloadTickets').deleteMany({ sessionHash });
    await db.collection('downloadGrants').deleteMany({ sessionHash });
    res.json({ success: true });
  });
  app.use('/api', async (req, res, next) => {
    const downloadPath = req.method === 'GET' && req.path.match(/^\/download\/([a-f\d-]{36})(?:\/(stc|gzip))?$/);
    const downloadId = downloadPath?.[1];
    if (downloadId && idValid(downloadId)) {
      const representation=downloadPath[2]||'original';
      const cookieName = `st_download_${downloadId.replaceAll('-', '')}${representation==='original'?'':'_'+representation}`;
      const value = (req.get('Cookie') || '').split(';').map(part => part.trim()).find(part => part.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
      const grant = /^[a-f\d]{64}$/.test(value || '') && await db.collection('downloadGrants').findOne({ _id: hash(value), fileId: downloadId, expiresAt: { $gt: new Date() }, ...(representation==='original'?{$or:[{representation:'original'},{representation:{$exists:false}}]}:{representation}) });
      if (!grant) return res.status(401).json({ error: 'Download access expired. Sign in and start the download again.' });
      req.identity = grant.identity; req.sessionHash = grant.sessionHash; req.contextOrganization = grant.orgId; req.downloadGrant = grant;
      return next();
    }
    const ticketToken = req.method === 'GET' && req.path.match(/^\/download\/([a-f\d]{64})$/)?.[1];
    if (ticketToken) {
      const ticket = await db.collection('downloadTickets').findOneAndDelete({ _id: hash(ticketToken), expiresAt: { $gt: new Date() } });
      const session = ticket && await sessions.findOne({ _id: ticket.sessionHash, email: ticket.identity, expiresAt: { $gt: new Date() } });
      if (!session) return res.status(401).json({ error: 'Download link expired. Sign in and start the download again.' });
      req.identity = ticket.identity; req.sessionHash = ticket.sessionHash; req.contextOrganization = ticket.orgId; req.downloadTicket = ticket;
      return next();
    }
    const token = req.get('Authorization')?.match(/^Bearer ([a-f\d]{64})$/)?.[1];
    const session = token && await sessions.findOne({ _id: hash(token), expiresAt: { $gt: new Date() } });
    if (!session) return res.status(401).json({ error: 'Sign in to continue' });
    req.identity = session.email; req.sessionHash = session._id; next();
  });
  platformRoutes({ app, db, config, audit });
  organizationRoutes({ app, db, pilot, audit, email });
  app.use('/api', async (req, res, next) => {
    req.org = await pilot.context(req);
    if (!req.org) return res.status(404).json({ error: 'Workspace unavailable' });
    next();
  });
  billingRoutes({ app, db, pilot, config, audit, payments });
  analyticsRoutes({ app, db });
  auditRoutes({ app, db });
  app.get('/api/operations', async (req, res) => {
    if (!['owner', 'admin'].includes(req.org.role)) return res.status(403).json({ error: 'Administrator access required' });
    const statuses = await transfers.aggregate([{ $match: { orgId: req.org._id } }, { $group: { _id: '$status', count: { $sum: 1 } } }]).toArray();
    const pendingNotifications = await transfers.countDocuments({ orgId: req.org._id, 'notification.status': 'pending', status: 'active' });
    const heartbeat = await db.collection('workers').findOne({ heartbeat: { $gt: new Date(Date.now() - 60000) } });
    res.json({ workerAvailable: !!heartbeat, transfers: Object.fromEntries(statuses.map(row => [row._id, row.count])), pendingNotifications });
  });
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
  resumableRoutes({ app, db, config, storage, pilot, audit, email, idValid, capacity });
  const compressed = compressionRoutes({app,db,storage,pilot,audit,idValid,capacity});
  app.post('/api/upload', capacity, async (req, res, next) => {
    if (req.org.status !== 'active' || req.org.role === 'viewer') return res.status(403).json({ error: 'This workspace cannot upload files' });
    const declared = req.get('X-File-Size');
    const legacyLimit = Math.min(config.maxSize, config.scanMaxSize, 25 * 1024 * 1024);
    if (declared !== undefined && (!/^\d{1,8}$/.test(declared) || Number(declared) > legacyLimit)) return res.status(400).json({ error: 'Use resumable upload for files over 25 MB' });
    req.uploadLimit = declared === undefined ? legacyLimit : Number(declared);
    req.reservationId = await pilot.reserve(req.org, req.uploadLimit);
    if (!req.reservationId) return res.status(409).json({ error: 'Workspace storage or file quota reached' });
    next();
  }, (req, res, next) => multer({ storage, limits: { fileSize: req.uploadLimit, files: 1, fields: 3, fieldSize: 1024, parts: 4 } }).single('file')(req, res, async error => {
    if (error) {
      await pilot.release(req.org._id, req.reservationId).catch(() => {});
      req.releaseCapacity(); return next(error);
    } next();
  }), async (req, res) => {
    if (!req.file) { await pilot.release(req.org._id, req.reservationId); return res.status(400).json({ error: 'Choose a file' }); }
    let persisted = false;
    try {
      const recipient = email(req.body.recipient), hours = Number(req.body.expiryHours || 24);
      if (!recipient || !Number.isInteger(hours) || hours < 1 || hours > 168) {
        await storage.remove(req.file.objectId);
        await pilot.release(req.org._id, req.reservationId);
        return res.status(400).json({ error: 'Provide a recipient and an expiry between 1 and 168 hours' });
      }
      const name = path.basename(req.file.originalname.replace(/\\/g, '/')).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 200) || 'download';
      const writer = await pilot.orgs.findOne({ _id: req.org._id, status: 'active', members: { $elemMatch: {
        email: req.identity, role: { $in: ['owner', 'admin', 'member'] },
      } } }, { projection: { _id: 1 } });
      if (!writer) {
        await storage.remove(req.file.objectId, req.file.storageBackend);
        await pilot.release(req.org._id, req.reservationId);
        return res.status(403).json({ error: 'Workspace upload access has changed' });
      }
      await pilot.resize(req.org._id, req.reservationId, req.file.size);
      const file = { _id: crypto.randomUUID(), owner: req.identity, recipient, name,
        orgId: req.org._id, reservationId: req.reservationId,
        objectId: req.file.objectId, size: req.file.size, iv: req.file.iv, tag: req.file.tag,
        storageBackend: req.file.storageBackend,
        version: req.file.version, keyId: req.file.keyId, wrappedKey: req.file.wrappedKey,
        wrappingIv: req.file.wrappingIv, wrappingTag: req.file.wrappingTag,
        status: 'quarantined', downloads: 0, createdAt: new Date(), expiresAt: new Date(Date.now() + hours * 3600000) };
      await transfers.insertOne(file); persisted = true;
      await audit('UPLOAD', req.identity, file._id, file.orgId);
      await db.collection('usage').updateOne({ _id: `upload:${file._id}` }, { $setOnInsert: { orgId: file.orgId, type: 'upload', bytes: file.size, fileId: file._id, at: new Date() } }, { upsert: true });
      const shareUrl = `${config.baseUrl}/?transfer=${file._id}`;
      res.status(201).json({ success: true, fileId: file._id, shareUrl, status: file.status, notified: false });
    } finally {
      if (!persisted) { await storage.remove(req.file.objectId); await pilot.release(req.org._id, req.reservationId); }
      req.releaseCapacity();
    }
  });
  app.get('/api/files', async (req, res) => {
    const requested = req.query.transfer;
    if (requested !== undefined && !idValid(requested)) return res.status(400).json({ error: 'Invalid transfer link' });
    const files = await transfers.find({ ...(requested ? { _id: requested } : {}), $or: [
      { orgId: req.org._id, ...(['owner', 'admin'].includes(req.org.role) ? {} : { owner: req.identity }) },
      { recipient: req.identity, recipientRevoked: { $ne: true } },
    ] }, { projection: { name: 1, owner: 1, recipient: 1, recipientRevoked: 1, orgId: 1, size: 1, status: 1, downloads: 1, expiresAt: 1, createdAt: 1, scanResult: 1, purpose:1,profile:1,exportFormat:1,restoredFileId:1 } }).sort({ createdAt: -1 }).limit(100).toArray();
    res.json({ files: await pilot.visible(files, req.identity, req.org._id) });
  });
  app.post('/api/file/:id/download-ticket', async (req, res) => {
    const representation=req.body?.representation||'original';
    if(!['original','stc','gzip'].includes(representation))return res.status(400).json({error:'Choose a supported download representation'});
    const file = idValid(req.params.id) && await transfers.findOne({ _id: req.params.id, status: 'active', expiresAt: { $gt: new Date() } });
    if (!file || !await pilot.authorize(file, req.identity, req.org._id, 'read')) return res.status(404).json({ error: 'File unavailable' });
    const ticket = crypto.randomBytes(32).toString('hex');
    await db.collection('downloadTickets').insertOne({ _id: hash(ticket), identity: req.identity, sessionHash: req.sessionHash, orgId: req.org._id, fileId: file._id, representation, expiresAt: new Date(Date.now() + 60000) });
    res.json({ url: `/api/download/${ticket}` });
  });
  app.get(['/api/file/:id/download', '/api/download/:ticket', '/api/download/:ticket/:representation'], capacity, async (req, res) => {
    try {
      const fileId = req.downloadTicket?.fileId || req.downloadGrant?.fileId || req.params.id;
      const file = idValid(fileId) && await transfers.findOne({ _id: fileId, $or: [
        { orgId: req.org._id, ...(['owner', 'admin'].includes(req.org.role) ? {} : { owner: req.identity }) },
        { recipient: req.identity, recipientRevoked: { $ne: true } },
      ], status: 'active', expiresAt: { $gt: new Date() } });
      if (!file) return res.status(404).json({ error: 'File unavailable' });
      if (!await pilot.authorize(file, req.identity, req.org._id, 'read')) return res.status(404).json({ error: 'File unavailable' });
      const representation=req.downloadTicket?.representation||req.downloadGrant?.representation||'original';
      if (req.downloadTicket) {
        const value = crypto.randomBytes(32).toString('hex'), url = `/api/download/${file._id}${representation==='original'?'':'/'+representation}`;
        await db.collection('downloadGrants').insertOne({ _id: hash(value), identity: req.identity, sessionHash: req.sessionHash, orgId: req.org._id, fileId: file._id, representation, expiresAt: file.expiresAt });
        const liveSession = await sessions.findOne({ _id: req.sessionHash, email: req.identity, expiresAt: { $gt: new Date() } });
        if (!liveSession) {
          await db.collection('downloadGrants').deleteOne({ _id: hash(value) });
          return res.status(401).json({ error: 'Download sign-in ended. Sign in and start the download again.' });
        }
        // A file-only capability lets native downloads resume beyond the one-hour app session.
        // It never authenticates other routes; logout, revocation, membership and billing are rechecked.
        res.cookie(`st_download_${file._id.replaceAll('-', '')}${representation==='original'?'':'_'+representation}`, value, { httpOnly: true, sameSite: 'strict', secure: config.baseUrl.startsWith('https:'), path: url, expires: file.expiresAt });
        return res.redirect(302, url);
      }
      if(representation!=='original')return await compressed.serveExport(req,res,file,representation);
      let range;
      try { range = byteRange(req.get('Range'), file.size); }
      catch (error) { if (error.status === 416) return res.status(416).set('Content-Range', `bytes */${file.size}`).end(); throw error; }
      // Verify the manifest before headers; each bounded part is authenticated before release.
      if (file.format === 'segments-v1') await storage.segmented.verifyManifest(file);
      const bytes = file.format === 'segments-v1' ? null : await storage.decrypt(file);
      const permission = await pilot.permission(file, req.identity, req.org._id);
      if (!permission.allowed) return res.status(404).json({ error: 'File unavailable' });
      // Recheck access after reading/authenticating, in case the owner revoked it.
      const access = await transfers.updateOne({ _id: file._id, status: 'active', expiresAt: { $gt: new Date() }, ...(!permission.administrative && file.owner !== req.identity ? { recipientRevoked: { $ne: true } } : {}) }, { $inc: { downloads: 1 } });
      if (!access.modifiedCount) return res.status(404).json({ error: 'File unavailable' });
      await audit('DOWNLOAD', req.identity, file._id, file.orgId);
      await db.collection('usage').insertOne({ _id: crypto.randomUUID(), orgId: file.orgId, type: 'download', bytes: range.length, fileId: file._id, at: new Date() });
      res.status(range.partial ? 206 : 200).set({ 'Accept-Ranges': 'bytes', 'Content-Length': String(range.length), 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(file.name.toWellFormed()).replace(/'/g, '%27')}` });
      if (range.partial) res.set('Content-Range', `bytes ${range.start}-${range.end}/${file.size}`);
      if (bytes) res.send(bytes.subarray(range.start, range.end + 1));
      else {
        async function* authorized() {
          for await (const chunk of storage.plaintext(file, range, true)) {
            const current = await transfers.findOne({ _id: file._id, status: 'active', expiresAt: { $gt: new Date() } });
            const grant = !req.downloadGrant || await db.collection('downloadGrants').findOne({ _id: req.downloadGrant._id, expiresAt: { $gt: new Date() } });
            if (!grant || !current || !await pilot.authorize(current, req.identity, req.org._id, 'read')) throw new Error('Download access ended');
            yield chunk;
          }
        }
        await pipeline(Readable.from(authorized()), res);
      }
    } finally { req.releaseCapacity(); }
  });
  app.delete('/api/file/:id', async (req, res) => {
    if (req.org.role === 'viewer') return res.status(403).json({ error: 'Viewer access cannot revoke files' });
    const filter = { _id: req.params.id, orgId: req.org._id,
      ...(['owner', 'admin'].includes(req.org.role) ? {} : { owner: req.identity }),
      status: { $in: ['active', 'quarantined', 'blocked', 'deleting'] } };
    const file = idValid(req.params.id) && await transfers.findOne(filter);
    if (!file || !await pilot.authorize(file, req.identity, req.org._id, 'manage')) return res.status(404).json({ error: 'File unavailable' });
    const revoked = await transfers.updateOne(filter, { $set: { status: 'deleting' } });
    if (!revoked.matchedCount) return res.status(404).json({ error: 'File unavailable' });
    await audit('REVOKE', req.identity, file._id, file.orgId);
    // Persist the tombstone first; the worker retries object deletion after failures.
    res.json({ success: true });
  });
  app.use(express.static(path.join(__dirname, '../public'), { dotfiles: 'deny' }));
  app.use((req, res) => res.status(404).json({ error: 'Not found' }));
  app.use((error, req, res, next) => {
    req.releaseCapacity?.();
    if (res.headersSent) return next(error);
    const status = error instanceof multer.MulterError ? 413 : error.type === 'entity.too.large' ? 413 : error instanceof SyntaxError && 'body' in error ? 400 : [400, 401, 403, 404, 409, 413, 416, 503].includes(error.status) ? error.status : 500;
    if (status === 500) console.error('Request failed:', error.name);
    res.status(status).json({ error: status === 413 ? 'Upload exceeds the allowed limits' : error.status && status !== 500 ? error.message : status === 400 ? 'Invalid JSON' : 'Request could not be completed' });
  });
  let cleaning = false;
  async function cleanup() {
    if (cleaning) return; cleaning = true;
    try {
      await transfers.updateMany({ $or: [{ status: { $in: ['active', 'quarantined'] }, expiresAt: { $lte: new Date() } }, { status: 'blocked' }] }, { $set: { status: 'deleting' } });
      for await (const file of transfers.find({ status: 'deleting' })) {
        if(file.purpose==='restore'&&file.restoreState!=='complete'){
          const restoredId=file.restoredFileId||require('./restore-job').stageId(file._id);
          await db.collection('uploads').updateOne({_id:restoredId,status:'finalizing'},{$set:{status:'cancelling'}});
          await transfers.updateOne({_id:restoredId,pendingRestoreParent:file._id,status:'quarantined'},{$set:{status:'deleting'}});
        }
        await storage.removeRecord(file);
        if (file.orgId && file.reservationId) await pilot.release(file.orgId, file.reservationId);
        await transfers.updateOne({ _id: file._id, status: 'deleting' }, { $set: { status: 'deleted', deletedAt: new Date() }, $unset: { iv: '', tag: '', wrappedKey: '', wrappingIv: '', wrappingTag: '' } });
      }
      await storage.segmented.cleanup(pilot);
      await pilot.reconcile();
      // Keep verified migration copies until the transfer itself is deleted.
      const cutoff = new Date(Date.now() - 3600000);
      let batch = [];
      const sweep = async () => {
        if (!batch.length) return;
        const ids = batch.map(object => object.id);
        const [files, parts] = await Promise.all([
          transfers.find({ objectId: { $in: ids }, status: { $ne: 'deleted' } }, { projection: { objectId: 1, storageBackend: 1, retainedBackends: 1 } }).toArray(),
          db.collection('chunks').find({ objectId: { $in: ids } }, { projection: { objectId: 1, storageBackend: 1, retainedBackends: 1 } }).toArray(),
        ]);
        const referenced = new Set([...files, ...parts].flatMap(row => [row.storageBackend || 'filesystem', ...(row.retainedBackends || [])].map(backend => `${backend}:${row.objectId}`)));
        for (const object of batch) if (!referenced.has(`${object.backend}:${object.id}`)) await storage.remove(object.id, object.backend);
        batch = [];
      };
      for await (const object of storage.list()) {
        if (object.modifiedAt >= cutoff) continue;
        batch.push(object);
        if (batch.length >= 1000) await sweep();
      }
      await sweep();
      await storage.cleanupMultipart(cutoff);
    } finally { cleaning = false; }
  }
  return { app, cleanup, worker, pilot };
}
module.exports = { createApp, email, idValid };
