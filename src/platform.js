const { PLANS } = require("./pilot");
const { period, usageAnalytics } = require("./analytics");
const projection = {
  name: 1,
  owner: 1,
  plan: 1,
  status: 1,
  usedBytes: 1,
  fileCount: 1,
  createdAt: 1,
  subscription: 1,
  members: 1,
  adminRevision: 1,
  adminSuspended: 1,
};
const safe = (org) => ({
  _id: org._id,
  name: org.name,
  owner: org.owner,
  plan: org.plan,
  status: org.status,
  usedBytes: org.usedBytes,
  fileCount: org.fileCount,
  createdAt: org.createdAt,
  seats: org.members.length,
  adminRevision: org.adminRevision || 0,
  adminSuspended: !!org.adminSuspended,
  subscription: org.subscription || {
    provider: "manual",
    status: org.status,
    revision: 0,
  },
  limits: PLANS[org.plan] || PLANS.pilot,
});
function platformRoutes({ app, db, config, audit }) {
  const isPlatformAdmin = (identity) =>
    (config.platformAdmins || []).includes(identity);
  app.get("/api/me", (req, res) =>
    res.json({
      email: req.identity,
      platformAdmin: isPlatformAdmin(req.identity),
    }),
  );
  app.use("/api/platform", (req, res, next) =>
    isPlatformAdmin(req.identity)
      ? next()
      : res
          .status(403)
          .json({ error: "Platform administrator access required" }),
  );
  app.get("/api/platform/clients", async (req, res) => {
    const search = req.query.search ?? "",
      cursor = req.query.cursor,
      limit = Number(req.query.limit ?? 20);
    if (
      typeof search !== "string" ||
      search.length > 100 ||
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 50 ||
      (cursor !== undefined &&
        (typeof cursor !== "string" || !/^[a-z\d_-]{1,100}$/i.test(cursor)))
    )
      return res.status(400).json({ error: "Invalid client search" });
    const pattern = search
      ? new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i")
      : null;
    const filter = {
      ...(cursor ? { _id: { $gt: cursor } } : {}),
      ...(pattern ? { $or: [{ name: pattern }, { owner: pattern }] } : {}),
    };
    const clients = await db
      .collection("organizations")
      .find(filter, { projection })
      .sort({ _id: 1 })
      .limit(limit + 1)
      .toArray();
    res.json({
      clients: clients.slice(0, limit).map(safe),
      nextCursor: clients.length > limit ? clients[limit - 1]._id : null,
    });
  });
  app.get("/api/platform/clients/:id", async (req, res) => {
    const client = await db
      .collection("organizations")
      .findOne({ _id: req.params.id }, { projection });
    if (!client) return res.status(404).json({ error: "Client unavailable" });
    res.json({ client: safe(client) });
  });
  app.put("/api/platform/clients/:id/subscription", async (req, res) => {
    const { plan, status, revision, reason } = req.body;
    if (
      !Object.hasOwn(PLANS, plan) ||
      !["active", "suspended"].includes(status) ||
      !Number.isSafeInteger(revision) ||
      revision < 0 ||
      typeof reason !== "string" ||
      reason.trim().length < 10 ||
      reason.length > 500
    )
      return res
        .status(400)
        .json({
          error: "Choose a plan, status and a reason of 10–500 characters",
        });
    const client = await db
      .collection("organizations")
      .findOne({ _id: req.params.id });
    if (!client) return res.status(404).json({ error: "Client unavailable" });
    if (
      client.subscription?.provider &&
      client.subscription.provider !== "manual"
    )
      return res
        .status(409)
        .json({
          error: "Manage this subscription through its payment provider",
        });
    const limits = PLANS[plan];
    const result = await db
      .collection("organizations")
      .updateOne(
        {
          _id: client._id,
          ...(revision === 0
            ? {
                $or: [
                  { "subscription.revision": 0 },
                  { subscription: { $exists: false } },
                ],
              }
            : { "subscription.revision": revision }),
          usedBytes: { $lte: limits.storageBytes },
          fileCount: { $lte: limits.files },
          $expr: { $lte: [{ $size: "$members" }, limits.seats] },
        },
        {
          $set: {
            plan,
            status,
            adminSuspended: status === "suspended",
            subscription: {
              provider: "manual",
              status,
              plan,
              revision: revision + 1,
              reason: reason.trim(),
              updatedAt: new Date(),
              updatedBy: req.identity,
            },
          },
        },
      );
    if (!result.modifiedCount)
      return res
        .status(409)
        .json({
          error:
            "Subscription changed or current usage exceeds this plan. Refresh before retrying.",
        });
    await audit("SUBSCRIPTION_MANUAL", req.identity, null, client._id);
    res.json({
      client: safe(
        await db
          .collection("organizations")
          .findOne({ _id: client._id }, { projection }),
      ),
    });
  });
  app.put("/api/platform/clients/:id/access", async (req, res) => {
    const { status, revision, reason } = req.body;
    if (
      !["active", "suspended"].includes(status) ||
      !Number.isSafeInteger(revision) ||
      revision < 0 ||
      typeof reason !== "string" ||
      reason.trim().length < 10 ||
      reason.length > 500
    )
      return res
        .status(400)
        .json({
          error:
            "Choose an access state and provide a reason of 10–500 characters",
        });
    const org = await db
      .collection("organizations")
      .findOne({ _id: req.params.id });
    if (!org) return res.status(404).json({ error: "Client unavailable" });
    const subscription = org.subscription;
    const billingPaused =
      subscription?.provider &&
      subscription.provider !== "manual" &&
      (!["active", "trialing"].includes(subscription.status) ||
        !Number.isFinite(+subscription.periodEnd) ||
        +subscription.periodEnd <= Date.now());
    const result = await db
      .collection("organizations")
      .updateOne(
        {
          _id: org._id,
          ...(revision === 0
            ? {
                $or: [
                  { adminRevision: 0 },
                  { adminRevision: { $exists: false } },
                ],
              }
            : { adminRevision: revision }),
          ...(subscription
            ? { subscription }
            : { subscription: { $exists: false } }),
        },
        {
          $set: {
            adminSuspended: status === "suspended",
            adminRevision: revision + 1,
            status:
              status === "suspended" || billingPaused ? "suspended" : "active",
            adminAccessReason: reason.trim(),
          },
        },
      );
    if (!result.modifiedCount)
      return res
        .status(409)
        .json({ error: "Client access changed. Refresh before retrying." });
    await audit("PLATFORM_ACCESS", req.identity, null, org._id);
    res.json({
      client: safe(
        await db
          .collection("organizations")
          .findOne({ _id: org._id }, { projection }),
      ),
    });
  });
  app.get("/api/platform/analytics", async (req, res) => {
    const window = period(req.query);
    if (!window)
      return res.status(400).json({ error: "Choose 7, 30 or 90 days" });
    const [usage, workspaces, revenue] = await Promise.all([
      usageAnalytics(db, window),
      db
        .collection("organizations")
        .aggregate([
          {
            $group: {
              _id: "$status",
              count: { $sum: 1 },
              usedBytes: { $sum: "$usedBytes" },
              fileCount: { $sum: "$fileCount" },
            },
          },
        ])
        .toArray(),
      db
        .collection("invoices")
        .aggregate([
          {
            $match: {
              status: "paid",
              test: false,
              at: { $gte: window.start, $lt: window.until },
            },
          },
          {
            $group: { _id: "$currency", amountMinor: { $sum: "$amountMinor" } },
          },
          { $sort: { _id: 1 } },
        ])
        .toArray(),
    ]);
    res.json({
      ...usage,
      workspaces,
      revenue: revenue.map((row) => ({
        currency: row._id,
        amountMinor: row.amountMinor,
      })),
    });
  });
}
module.exports = { platformRoutes };
