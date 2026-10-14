const { PLANS, recipientKey } = require('./pilot');
function organizationRoutes({ app, db, pilot, audit, email }) {
  const safe = org => ({ _id: org._id, name: org.name, owner: org.owner, members: org.members,
    plan: org.plan, status: org.status, usedBytes: org.usedBytes, fileCount: org.fileCount,
    limits: PLANS[org.plan] || PLANS.pilot });
  app.get('/api/organizations', async (req, res) => {
    await pilot.personal(req.identity);
    const orgs = await pilot.orgs.find({ 'members.email': req.identity }).toArray();
    res.json({ organizations: orgs.map(safe) });
  });
  app.post('/api/organizations', async (req, res) => {
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    if (!name || name.length > 80) return res.status(400).json({ error: 'Workspace name must be between 1 and 80 characters' });
    const org = await pilot.createTeam(req.identity, name);
    if (!org) return res.status(409).json({ error: 'Pilot accounts can create up to three team workspaces' });
    await audit('ORG_CREATE', req.identity, null, org._id);
    res.status(201).json({ organization: safe(org) });
  });
  app.put('/api/organizations/:id/members', async (req, res) => {
    const address = email(req.body.email), role = req.body.role;
    if (!address || !['admin', 'member', 'viewer'].includes(role)) return res.status(400).json({ error: 'Provide an email and a valid role' });
    const org = await pilot.orgs.findOne({ _id: req.params.id, members: { $elemMatch: { email: req.identity, role: { $in: ['owner', 'admin'] } } } });
    if (!org) return res.status(404).json({ error: 'Workspace unavailable' });
    if (org.owner === address) return res.status(409).json({ error: 'The owner role cannot be changed' });
    if (org.members.find(member => member.email === req.identity).role !== 'owner' && role === 'admin') return res.status(403).json({ error: 'Only the owner can grant administrator access' });
    const member = org.members.find(member => member.email === address);
    if (member?.role === 'admin' && org.owner !== req.identity) return res.status(403).json({ error: 'Only the owner can change an administrator' });
    const filter = { _id: org._id, members: org.members, plan: org.plan };
    let result;
    if (member) result = await pilot.orgs.updateOne(filter, { $set: { members: org.members.map(item => item.email === address ? { email: address, role } : item) } });
    else {
      if (org.members.length >= (PLANS[org.plan] || PLANS.pilot).seats) return res.status(409).json({ error: 'Workspace seat limit reached' });
      result = await pilot.orgs.updateOne(filter, { $push: { members: { email: address, role } } });
    }
    if (!result.modifiedCount) return res.status(409).json({ error: 'Membership changed. Refresh and try again.' });
    await audit('MEMBER_SET', req.identity, null, org._id);
    res.json({ organization: safe(await pilot.orgs.findOne({ _id: org._id })) });
  });
  app.delete('/api/organizations/:id/members/:email', async (req, res) => {
    const org = await pilot.orgs.findOne({ _id: req.params.id, owner: req.identity });
    if (!org) return res.status(404).json({ error: 'Workspace unavailable' });
    const address = email(req.params.email);
    if (!address || address === org.owner) return res.status(400).json({ error: 'The workspace owner cannot be removed' });
    await pilot.orgs.updateOne({ _id: org._id, owner: req.identity }, {
      $pull: { members: { email: address } }, $set: { [`recipientRevocations.${recipientKey(address)}`]: new Date() },
    });
    // Remove grants on that organization's files as well as team membership.
    await db.collection('transfers').updateMany({ orgId: org._id, recipient: address }, { $set: { recipientRevoked: true } });
    await audit('MEMBER_REMOVE', req.identity, null, org._id);
    res.json({ success: true });
  });
}
module.exports = { organizationRoutes };
