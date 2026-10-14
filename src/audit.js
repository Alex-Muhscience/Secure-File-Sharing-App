const crypto = require('node:crypto');
function createAudit(db) {
  return async (action, actor, transferId, orgId) => {
    await db.collection('audit').insertOne({ _id: crypto.randomUUID(), action, actor, transferId: transferId || null,
      orgId: orgId || null, at: new Date() });
  };
}
function auditRoutes({ app, db }) {
  app.get('/api/audit/export', async (req, res) => {
    if (!['owner', 'admin'].includes(req.org.role)) return res.status(403).json({ error: 'Administrator access required' });
    const cursor = typeof req.query.cursor === 'string' ? req.query.cursor : null;
    if (cursor && !/^[a-f\d-]{36}$/.test(cursor)) return res.status(400).json({ error: 'Invalid audit cursor' });
    const rows = await db.collection('audit').find({ orgId: req.org._id, ...(cursor ? { _id: { $gt: cursor } } : {}) }).sort({ _id: 1 }).limit(1000).toArray();
    res.set({ 'Content-Type': 'application/x-ndjson', 'Content-Disposition': 'attachment; filename="audit.ndjson"',
      'X-Next-Cursor': rows.length === 1000 ? rows.at(-1)._id : '' });
    res.send(rows.map(row => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''));
  });
}
module.exports = { createAudit, auditRoutes };
