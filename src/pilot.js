const crypto = require('node:crypto');
const PLANS = Object.freeze({
  pilot: { storageBytes: 100 * 1024 * 1024, files: 100, seats: 5 },
  team: { storageBytes: 1024 * 1024 * 1024, files: 1000, seats: 25 },
});
const personalId = email => `personal_${crypto.createHash('sha256').update(email).digest('hex')}`;
class Pilot {
  constructor(db) { this.db = db; this.orgs = db.collection('organizations'); }
  async personal(email) {
    const id = personalId(email);
    await this.orgs.updateOne({ _id: id }, { $setOnInsert: {
      name: 'Personal workspace', owner: email, members: [{ email, role: 'owner' }],
      plan: 'pilot', status: 'active', usedBytes: 0, fileCount: 0, reservations: [], createdAt: new Date(),
    } }, { upsert: true });
    return this.orgs.findOne({ _id: id });
  }
  async context(req) {
    const id = req.get('X-Organization-ID');
    const org = id ? await this.orgs.findOne({ _id: id, 'members.email': req.identity }) : await this.personal(req.identity);
    if (!org) return null;
    const member = org.members.find(member => member.email === req.identity);
    return { ...org, role: member.role, limits: PLANS[org.plan] || PLANS.pilot };
  }
  async reserve(org, bytes) {
    const id = crypto.randomUUID();
    const result = await this.orgs.updateOne({ _id: org._id, status: 'active',
      usedBytes: { $lte: org.limits.storageBytes - bytes }, fileCount: { $lt: org.limits.files },
    }, { $inc: { usedBytes: bytes, fileCount: 1 }, $push: { reservations: { id, bytes, createdAt: new Date() } } });
    return result.modifiedCount ? id : null;
  }
  async release(orgId, reservationId) {
    // Optimistic compare-and-swap updates counters and removes the reservation atomically.
    for (;;) {
      const org = await this.orgs.findOne({ _id: orgId, 'reservations.id': reservationId });
      if (!org) return;
      const reservation = org.reservations.find(item => item.id === reservationId);
      const result = await this.orgs.updateOne({ _id: orgId, usedBytes: org.usedBytes, fileCount: org.fileCount, 'reservations.id': reservationId }, {
        $inc: { usedBytes: -reservation.bytes, fileCount: -1 }, $pull: { reservations: { id: reservationId } },
      });
      if (result.modifiedCount) return;
    }
  }
  async resize(orgId, reservationId, bytes) {
    const org = await this.orgs.findOne({ _id: orgId, 'reservations.id': reservationId });
    const reservation = org?.reservations.find(item => item.id === reservationId);
    if (!reservation || bytes > reservation.bytes) throw new Error('Invalid quota reservation');
    await this.orgs.updateOne({ _id: orgId, reservations: { $elemMatch: { id: reservationId, bytes: reservation.bytes } } }, {
      $inc: { usedBytes: bytes - reservation.bytes }, $set: { 'reservations.$.bytes': bytes },
    });
  }
  async migrate() {
    for await (const file of this.db.collection('transfers').find({ orgId: { $exists: false } })) {
      const org = await this.personal(file.owner), reservationId = file._id;
      if (file.status !== 'deleted') await this.orgs.updateOne({ _id: org._id, 'reservations.id': { $ne: reservationId } }, {
        $inc: { usedBytes: file.size, fileCount: 1 }, $push: { reservations: { id: reservationId, bytes: file.size, createdAt: file.createdAt } },
      });
      await this.db.collection('transfers').updateOne({ _id: file._id, orgId: { $exists: false } }, { $set: {
        orgId: org._id, reservationId, ...(file.status === 'active' ? { status: 'quarantined' } : {}),
      } });
    }
  }
  async reconcile() {
    for await (const org of this.orgs.find({ 'reservations.0': { $exists: true } })) {
      for (const reservation of org.reservations) {
        if (+reservation.createdAt < Date.now() - 3600000 && !await this.db.collection('transfers').findOne({ orgId: org._id, reservationId: reservation.id, status: { $ne: 'deleted' } })) await this.release(org._id, reservation.id);
      }
    }
  }
}
module.exports = { Pilot, PLANS, personalId };
