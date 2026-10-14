const crypto = require('node:crypto');
class Worker {
  constructor({ config, db, storage, mail, scanner, audit }) {
    Object.assign(this, { config, db, storage, mail, scanner, audit });
    this.transfers = db.collection('transfers'); this.running = false;
    this.id = crypto.randomUUID();
  }
  async tick() {
    if (this.running) return; this.running = true;
    try {
      await this.db.collection('workers').updateOne({ _id: this.id }, { $set: { heartbeat: new Date() } }, { upsert: true });
      // Each job lives on the transfer so it cannot be lost between metadata and queue writes.
      for (let count = 0; count < 20; count++) {
        const lease = crypto.randomUUID(), now = new Date();
        const file = await this.transfers.findOneAndUpdate({ status: 'quarantined', expiresAt: { $gt: now },
          $and: [{ $or: [{ scanRetryAt: { $exists: false } }, { scanRetryAt: { $lte: now } }] },
            { $or: [{ scanLeaseUntil: { $exists: false } }, { scanLeaseUntil: { $lte: now } }] }],
        }, { $set: { scanLease: lease, scanLeaseUntil: new Date(+now + 120000) }, $inc: { scanAttempts: 1 } }, { returnDocument: 'after' });
        if (!file) break;
        await this.db.collection('workers').updateOne({ _id: this.id }, { $set: { heartbeat: new Date() } });
        try {
          const result = await this.scanner.scan(await this.storage.decrypt(file));
          const update = await this.transfers.updateOne({ _id: file._id, status: 'quarantined', scanLease: lease }, {
            $set: { status: result.clean ? 'active' : 'blocked', scanResult: result.clean ? 'clean' : 'infected', scannedAt: new Date(),
              ...(result.clean ? { notification: { status: 'pending', attempts: 0, nextAttempt: new Date() } } : { blockedAt: new Date() }) },
            $unset: { scanLease: '', scanLeaseUntil: '', scanRetryAt: '' },
          });
          if (update.modifiedCount) await this.audit(result.clean ? 'SCAN_CLEAN' : 'SCAN_BLOCKED', 'worker', file._id, file.orgId);
        } catch {
          await this.transfers.updateOne({ _id: file._id, scanLease: lease }, { $set: { scanRetryAt: new Date(Date.now() + Math.min(3600000, 1000 * 2 ** Math.min(file.scanAttempts, 12))) }, $unset: { scanLease: '', scanLeaseUntil: '' } });
        }
      }
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
    } finally { this.running = false; }
  }
}
module.exports = { Worker };
