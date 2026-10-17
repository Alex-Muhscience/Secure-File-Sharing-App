const crypto = require('node:crypto');
class Worker {
  constructor({ config, db, storage, mail, scanner, audit, payments }) {
    Object.assign(this, { config, db, storage, mail, scanner, audit, payments });
    this.transfers = db.collection('transfers'); this.running = false;
    this.id = crypto.randomUUID();
  }
  async tick() {
    if (this.running) return; this.running = true;
    const heartbeat = setInterval(() => this.db.collection('workers').updateOne({ _id: this.id }, { $set: { heartbeat: new Date() } }, { upsert: true }).catch(() => {}), 20000); heartbeat.unref();
    try {
      await this.db.collection('workers').updateOne({ _id: this.id }, { $set: { heartbeat: new Date() } }, { upsert: true });
      await this.payments?.tick();
      // Each job lives on the transfer so it cannot be lost between metadata and queue writes.
      for (let count = 0; count < 20; count++) {
        const lease = crypto.randomUUID(), now = new Date();
        const file = await this.transfers.findOneAndUpdate({ status: 'quarantined', expiresAt: { $gt: now },
          $and: [{ $or: [{ scanRetryAt: { $exists: false } }, { scanRetryAt: { $lte: now } }] },
            { $or: [{ scanLeaseUntil: { $exists: false } }, { scanLeaseUntil: { $lte: now } }] }],
        }, { $set: { scanLease: lease, scanLeaseUntil: new Date(+now + 120000) }, $inc: { scanAttempts: 1 } }, { returnDocument: 'after' });
        if (!file) break;
        await this.db.collection('workers').updateOne({ _id: this.id }, { $set: { heartbeat: new Date() } });
        if (file.size > this.config.scanMaxSize) {
          await this.transfers.updateOne({ _id: file._id, scanLease: lease }, { $set: { scanResult: 'size_limit', scanRetryAt: new Date(Date.now() + 86400000) }, $unset: { scanLease: '', scanLeaseUntil: '' } });
          continue;
        }
        const renew = setInterval(() => {
          Promise.all([
            this.transfers.updateOne({ _id: file._id, scanLease: lease, status: 'quarantined' }, { $set: { scanLeaseUntil: new Date(Date.now() + 120000) } }),
            this.db.collection('workers').updateOne({ _id: this.id }, { $set: { heartbeat: new Date() } }),
          ]).catch(() => {});
        }, 20000);
        renew.unref();
        try {
          const result = file.format === 'segments-v1'
            ? await this.scanner.scanStream(this.storage.plaintext(file), { size: file.size, fileId: file._id })
            : await this.scanner.scan(await this.storage.decrypt(file));
          const update = await this.transfers.updateOne({ _id: file._id, status: 'quarantined', scanLease: lease }, {
            $set: { status: result.clean ? 'active' : 'blocked', scanResult: result.clean ? 'clean' : 'infected', scannedAt: new Date(),
              ...(result.clean ? { notification: { status: 'pending', attempts: 0, nextAttempt: new Date() } } : { blockedAt: new Date() }) },
            $unset: { scanLease: '', scanLeaseUntil: '', scanRetryAt: '' },
          });
          if (update.modifiedCount) await this.audit(result.clean ? 'SCAN_CLEAN' : 'SCAN_BLOCKED', 'worker', file._id, file.orgId);
        } catch {
          await this.transfers.updateOne({ _id: file._id, scanLease: lease }, { $set: { scanRetryAt: new Date(Date.now() + Math.min(3600000, 1000 * 2 ** Math.min(file.scanAttempts, 12))) }, $unset: { scanLease: '', scanLeaseUntil: '' } });
        } finally { clearInterval(renew); }
      }
      await this.notify();
    } finally { clearInterval(heartbeat); this.running = false; }
  }
  async maintain() {
    if (this.maintaining) return; this.maintaining = true;
    try { await this.payments?.tick(); await this.notify(); }
    finally { this.maintaining = false; }
  }
  async notify() {
    if (this.notifying) return; this.notifying = true;
    try {
      for (let count = 0; count < 20; count++) {
        const lease = crypto.randomUUID(), now = new Date();
        const file = await this.transfers.findOneAndUpdate({ status: 'active', expiresAt: { $gt: now }, 'notification.status': 'pending',
          'notification.nextAttempt': { $lte: now }, $or: [{ 'notification.leaseUntil': { $exists: false } }, { 'notification.leaseUntil': { $lte: now } }],
        }, { $set: { 'notification.lease': lease, 'notification.leaseUntil': new Date(+now + 60000) }, $inc: { 'notification.attempts': 1 } }, { returnDocument: 'after' });
        if (!file) break;
        await this.db.collection('workers').updateOne({ _id: this.id }, { $set: { heartbeat: new Date() } });
        try {
          await this.mail.sendMail({ from: this.config.from, to: file.recipient, messageId: `<transfer-${file._id}@secure-transfer.local>`,
            subject: 'A file has been shared with you', text: `${file.owner} shared ${file.name}. Sign in with this email to download: ${this.config.baseUrl}/?transfer=${file._id}\nExpires: ${file.expiresAt.toISOString()}` });
          await this.transfers.updateOne({ _id: file._id, 'notification.lease': lease }, { $set: { 'notification.status': 'sent', 'notification.sentAt': new Date() }, $unset: { 'notification.lease': '', 'notification.leaseUntil': '' } });
        } catch {
          await this.transfers.updateOne({ _id: file._id, 'notification.lease': lease }, { $set: { 'notification.nextAttempt': new Date(Date.now() + Math.min(3600000, 1000 * 2 ** Math.min(file.notification.attempts, 12))) }, $unset: { 'notification.lease': '', 'notification.leaseUntil': '' } });
        }
      }
    } finally { this.notifying = false; }
  }

}
module.exports = { Worker };
