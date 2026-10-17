const DAY = 86400000;
const administrator = (req, res, next) =>
  ["owner", "admin"].includes(req.org.role)
    ? next()
    : res.status(403).json({ error: "Administrator access required" });
function period(query, now = new Date()) {
  const days = query.days === undefined ? 30 : Number(query.days);
  if (![7, 30, 90].includes(days)) return null;
  const end = new Date(now);
  end.setUTCHours(0, 0, 0, 0);
  return {
    days,
    start: new Date(+end - (days - 1) * DAY),
    until: new Date(+end + DAY),
  };
}
async function usageAnalytics(db, window, orgId) {
  const rows = await db
    .collection("usage")
    .aggregate([
      {
        $match: {
          ...(orgId ? { orgId } : {}),
          at: { $gte: window.start, $lt: window.until },
          type: { $in: ["upload", "download"] },
        },
      },
      {
        $group: {
          _id: {
            day: {
              $dateToString: {
                format: "%Y-%m-%d",
                date: "$at",
                timezone: "UTC",
              },
            },
            type: "$type",
          },
          count: { $sum: 1 },
          bytes: { $sum: "$bytes" },
          saved: {
            $sum: {
              $cond: [
                { $eq: ["$type", "upload"] },
                {
                  $max: [
                    0,
                    {
                      $subtract: [
                        "$bytes",
                        { $ifNull: ["$storedBytes", "$bytes"] },
                      ],
                    },
                  ],
                },
                0,
              ],
            },
          },
        },
      },
    ])
    .toArray();
  const byDay = new Map();
  const series = Array.from({ length: window.days }, (_, i) => {
    const row = {
      date: new Date(+window.start + i * DAY).toISOString().slice(0, 10),
      uploads: 0,
      downloads: 0,
      uploadBytes: 0,
      downloadBytes: 0,
      compressionSavedBytes: 0,
    };
    byDay.set(row.date, row);
    return row;
  });
  for (const row of rows) {
    const day = byDay.get(row._id.day);
    const upload = row._id.type === "upload";
    day[upload ? "uploads" : "downloads"] += row.count;
    day[upload ? "uploadBytes" : "downloadBytes"] += row.bytes;
    day.compressionSavedBytes += row.saved;
  }
  const totals = {
    uploads: 0,
    downloads: 0,
    uploadBytes: 0,
    downloadBytes: 0,
    compressionSavedBytes: 0,
  };
  for (const day of series)
    for (const key of Object.keys(totals)) totals[key] += day[key];
  return { days: window.days, timezone: "UTC", series, totals };
}
function analyticsRoutes({ app, db }) {
  app.get("/api/analytics", administrator, async (req, res) => {
    const window = period(req.query);
    if (!window)
      return res.status(400).json({ error: "Choose 7, 30 or 90 days" });
    const [usage, statuses] = await Promise.all([
      usageAnalytics(db, window, req.org._id),
      db
        .collection("transfers")
        .aggregate([
          { $match: { orgId: req.org._id } },
          { $group: { _id: "$status", count: { $sum: 1 } } },
        ])
        .toArray(),
    ]);
    res.json({
      ...usage,
      storage: {
        usedBytes: req.org.usedBytes,
        limitBytes: req.org.limits.storageBytes,
        fileCount: req.org.fileCount,
      },
      statuses: Object.fromEntries(statuses.map((row) => [row._id, row.count])),
    });
  });
}
module.exports = { administrator, period, usageAnalytics, analyticsRoutes };
