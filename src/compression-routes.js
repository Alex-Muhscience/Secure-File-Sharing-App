const crypto = require("node:crypto");
const { Readable, compose } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { createGzip } = require("node:zlib");
const { archive, archiveFromParts } = require("./compressed-archive");
const { ratio } = require("./benchmark-metrics");
const fail = (status, message) => Object.assign(new Error(message), { status });
function compressionRoutes({
  app,
  db,
  storage,
  pilot,
  audit,
  idValid,
  capacity,
}) {
  const transfers = db.collection("transfers");
  async function find(req, id, active = true) {
    const file =
      idValid(id) &&
      (await transfers.findOne({
        _id: id,
        ...(active
          ? { status: "active", expiresAt: { $gt: new Date() } }
          : { status: { $nin: ["deleted", "deleting"] } }),
      }));
    if (
      !file ||
      !(await pilot.authorize(
        file,
        req.identity,
        req.org._id,
        active ? "read" : "view",
      ))
    )
      throw fail(404, "File unavailable");
    return file;
  }
  async function guard(req, file) {
    const current = await find(req, file._id);
    if (
      req.downloadGrant &&
      !(await db.collection("downloadGrants").findOne({
        _id: req.downloadGrant._id,
        expiresAt: { $gt: new Date() },
      }))
    )
      throw fail(401, "Download access ended");
    return current;
  }
  async function* original(req, file) {
    for await (const bytes of storage.plaintext(file)) {
      await guard(req, file);
      yield bytes;
    }
  }
  async function* parts(req, file) {
    for await (const part of db
      .collection("chunks")
      .find({ uploadId: file._id })
      .sort({ index: 1 })) {
      await guard(req, file);
      const bytes = storage.authenticate(
        part,
        await storage.readCiphertext(part),
      );
      yield { bytes, codec: part.codec, size: part.size, sha256: part.sha256 };
    }
  }
  async function serveExport(req, res, file, format) {
    if (!["stc", "gzip"].includes(format))
      throw fail(400, "Choose a supported archive format");
    await guard(req, file);
    if (req.get("Range"))
      return res.status(416).json({
        error:
          "Streaming archive exports do not support byte ranges. Restart the export.",
      });
    if (file.format === "segments-v1")
      await storage.segmented.verifyManifest(file);
    await guard(req, file);
    const source =
      format === "stc"
        ? file.format === "segments-v1" && file.chunkSize <= 16 * 1024 * 1024
          ? archiveFromParts(parts(req, file), {
              name: file.name,
              size: file.size,
            })
          : archive(original(req, file), {
              name: file.name,
              size: file.size,
              mode: file.compression === "research" ? "research" : "adaptive",
            })
        : compose(Readable.from(original(req, file)), createGzip({ level: 6 }));
    let emitted = 0;
    async function* counted() {
      for await (const bytes of source) {
        await guard(req, file);
        emitted += bytes.length;
        yield bytes;
      }
    }
    const name = (
      file.name + (format === "stc" ? ".stc" : ".gz")
    ).toWellFormed();
    res.set({
      "Content-Type":
        format === "gzip" ? "application/gzip" : "application/octet-stream",
      "Content-Disposition": `attachment; filename="archive.${format === "stc" ? "stc" : "gz"}"; filename*=UTF-8''${encodeURIComponent(name).replace(/'/g, "%27")}`,
      "Cache-Control": "no-store",
    });
    await audit("EXPORT", req.identity, file._id, file.orgId);
    await transfers.updateOne(
      { _id: file._id, status: "active" },
      { $inc: { downloads: 1 } },
    );
    await pipeline(Readable.from(counted()), res);
    await transfers.updateOne(
      { _id: file._id },
      {
        $set: {
          [`exports.${format}`]: {
            completedBytes: emitted,
            completedAt: new Date(),
            ...ratio(file.size, emitted),
          },
        },
      },
    );
    await db.collection("usage").insertOne({
      _id: crypto.randomUUID(),
      orgId: file.orgId,
      type: "export",
      format,
      bytes: emitted,
      logicalBytes: file.size,
      fileId: file._id,
      at: new Date(),
    });
  }
  app.get("/api/file/:id/export/:format", capacity, async (req, res) => {
    try {
      await serveExport(
        req,
        res,
        await find(req, req.params.id),
        req.params.format,
      );
    } finally {
      req.releaseCapacity();
    }
  });
  app.get("/api/file/:id/compression", async (req, res) => {
    const file = await find(req, req.params.id, false);
    const codecCounts =
      file.format === "segments-v1"
        ? await db
            .collection("chunks")
            .aggregate([
              { $match: { uploadId: file._id } },
              {
                $group: {
                  _id: "$codec",
                  parts: { $sum: 1 },
                  storedBytes: { $sum: "$storedSize" },
                  originalBytes: { $sum: "$size" },
                },
              },
            ])
            .toArray()
        : [];
    res.json({
      fileId: file._id,
      name: file.name,
      status: file.status,
      scanResult: file.scanResult,
      purpose: file.purpose || "send",
      profile: file.profile || "documents",
      originalBytes: file.size,
      storedBytes: file.storedSize ?? file.size,
      uploadPayloadBytes: file.uploadPayloadBytes ?? null,
      codecCounts,
      exports: file.exports || {},
      restoredFileId: file.restoredFileId || null,
      restoreError: file.restoreError || null,
    });
  });
  return { serveExport, find, guard };
}
module.exports = { compressionRoutes };
