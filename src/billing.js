const crypto = require('node:crypto');
const { PLANS } = require('./pilot');
function billingRoutes({ app, db, pilot, config, audit }) {
  app.get('/api/usage', async (req, res) => {
    const records = await db.collection('usage').find({ orgId: req.org._id }).sort({ at: -1 }).limit(100).toArray();
    res.json({ plan: req.org.plan, limits: req.org.limits, usedBytes: req.org.usedBytes, fileCount: req.org.fileCount, records });
  });
  // Local billing sandbox. No payments are collected and no provider state is implied.
  app.post('/api/billing/sandbox/events', async (req, res) => {
    if (!config.billingSandbox) return res.status(404).json({ error: 'Billing sandbox is disabled' });
    if (req.org.role !== 'owner') return res.status(403).json({ error: 'Only the workspace owner can change its sandbox plan' });
    const { eventId, plan, status } = req.body;
    if (typeof eventId !== 'string' || !/^[a-z\d_-]{8,80}$/i.test(eventId) || !Object.hasOwn(PLANS, plan) || !['active', 'suspended'].includes(status)) return res.status(400).json({ error: 'Invalid sandbox event' });
    const event = { plan, status };
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify(event)).digest('hex');
    const key = `${req.org._id}:${eventId}`;
    // Embedded immutable event IDs and entitlement update are one atomic document change.
    const existing = await pilot.orgs.findOne({ _id: req.org._id, 'billingEvents.id': key });
    if (existing) {
      const original = existing.billingEvents.find(item => item.id === key);
      if (original.fingerprint !== fingerprint) return res.status(409).json({ error: 'Event ID was already used with different data' });
      return res.json({ success: true, duplicate: true });
    }
    const org = await pilot.orgs.findOne({ _id: req.org._id });
    if ((org.billingEvents?.length || 0) >= 1000) return res.status(409).json({ error: 'Sandbox event limit reached' });
    const result = await pilot.orgs.updateOne({ _id: req.org._id, owner: req.identity, 'billingEvents.id': { $ne: key } }, {
      $set: { plan, status }, $push: { billingEvents: { id: key, fingerprint, ...event, at: new Date() } },
    });
    if (!result.modifiedCount) {
      const latest = await pilot.orgs.findOne({ _id: req.org._id });
      if (latest.billingEvents?.find(item => item.id === key)?.fingerprint !== fingerprint) return res.status(409).json({ error: 'Conflicting event' });
    }
    await audit('BILLING_SANDBOX', req.identity, null, req.org._id);
    res.json({ success: true, duplicate: !result.modifiedCount });
  });
}
module.exports = { billingRoutes };
