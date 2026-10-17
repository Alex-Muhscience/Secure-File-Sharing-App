const crypto = require('node:crypto');
const { PLANS } = require('./pilot');
const { administrator } = require('./analytics');
function billingRoutes({ app, db, pilot, config, audit, payments }) {
  app.get('/api/billing/overview', administrator, async (req, res) => {
    const invoices = await db.collection('invoices').find({ orgId: req.org._id }, { projection: { currency: 1, amountMinor: 1, status: 1, test: 1, at: 1, number: 1, provider: 1 } }).sort({ at: -1 }).limit(50).toArray();
    res.json({ plan: req.org.plan, limits: req.org.limits, usedBytes: req.org.usedBytes, seats: req.org.members.length,
      subscription: req.org.subscription || { provider: 'manual', status: req.org.status, revision: 0 },
      providers: payments.gateway.list(), catalog: payments.catalog(), invoices,
      orders: (await payments.orders.find({ orgId: req.org._id }).sort({ createdAt: -1 }).limit(20).toArray()).map(order => payments.publicOrder(order)),
    });
  });
  app.post('/api/billing/checkout', async (req, res) => res.status(201).json(await payments.checkout(req)));
  app.get('/api/billing/orders/:id', administrator, async (req, res) => {
    const order = await payments.orders.findOne({ _id: req.params.id, orgId: req.org._id });
    if (!order) return res.status(404).json({ error: 'Payment unavailable' });
    res.json(payments.publicOrder(order));
  });
  app.post('/api/billing/portal', async (req, res) => {
    if (req.org.role !== 'owner') return res.status(403).json({ error: 'Only the workspace owner can manage payments' });
    if (req.org.subscription?.provider !== 'stripe' || !req.org.subscription.customerId || !payments.gateway.stripe) return res.status(409).json({ error: 'No recurring Stripe subscription is configured' });
    const portal = await payments.gateway.stripe.billingPortal.sessions.create({ customer: req.org.subscription.customerId, return_url: `${config.baseUrl}/#billing` });
    if (new URL(portal.url).origin !== 'https://billing.stripe.com') throw new Error('Invalid Stripe portal URL');
    res.json({ url: portal.url });
  });
  app.get('/api/usage', async (req, res) => {
    const records = await db.collection('usage').find({ orgId: req.org._id }).sort({ at: -1 }).limit(100).toArray();
    res.json({ plan: req.org.plan, limits: req.org.limits, usedBytes: req.org.usedBytes, fileCount: req.org.fileCount, records });
  });
  // Local billing sandbox. No payments are collected and no provider state is implied.
  app.post('/api/billing/sandbox/events', async (req, res) => {
    if (!config.billingSandbox) return res.status(404).json({ error: 'Billing sandbox is disabled' });
    if (req.org.role !== 'owner') return res.status(403).json({ error: 'Only the workspace owner can change its sandbox plan' });
    if (req.org.adminSuspended) return res.status(403).json({ error: 'A platform administrator has paused this workspace' });
    if (req.org.subscription?.provider && req.org.subscription.provider !== 'manual') return res.status(409).json({ error: 'Manage this paid subscription through Billing' });
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
    const limits = PLANS[plan];
    const result = await pilot.orgs.updateOne({ _id: req.org._id, owner: req.identity, 'billingEvents.id': { $ne: key },
      adminSuspended: { $ne: true },
      subscription: req.org.subscription || { $exists: false },
      entitlementEpoch: req.org.entitlementEpoch === undefined ? { $exists: false } : req.org.entitlementEpoch,
      usedBytes: { $lte: limits.storageBytes }, fileCount: { $lte: limits.files },
      $expr: { $and: [{ $lte: [{ $size: '$members' }, limits.seats] }, { $lt: [{ $size: { $ifNull: ['$billingEvents', []] } }, 1000] }] },
    }, {
      $set: { plan, status }, $push: { billingEvents: { id: key, fingerprint, ...event, at: new Date() } }, $inc: { entitlementEpoch: 1 },
    });
    if (!result.modifiedCount) {
      const latest = await pilot.orgs.findOne({ _id: req.org._id });
      if (latest.billingEvents?.find(item => item.id === key)?.fingerprint !== fingerprint) return res.status(409).json({ error: 'Event conflicts or current usage exceeds the selected plan limits' });
    }
    await audit('BILLING_SANDBOX', req.identity, null, req.org._id);
    res.json({ success: true, duplicate: !result.modifiedCount });
  });
}
module.exports = { billingRoutes };
