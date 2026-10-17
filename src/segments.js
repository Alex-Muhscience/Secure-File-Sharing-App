const crypto = require("node:crypto");
const path = require("node:path");
const express = require("express");
const { sha256 } = require("./parts");
const { decodeTransport } = require('./chunk-transport');
const { PROFILES } = require('./file-profiles');
const { isActive } = require("./pilot");
const failure = (status, message) =>
  Object.assign(new Error(message), { status });
class Segments {
  constructor(storage, db) {
    this.storage = storage;
    this.db = db;
    this.uploads = db.collection("uploads");
    this.chunks = db.collection("chunks");
  }
  async manifest(file) {
    if (
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      !Number.isInteger(file.chunkCount) ||
      file.chunkCount < 0 ||
      file.chunkCount > 1000000
    )
      throw new Error("Invalid file manifest");
    const mac = crypto.createHmac("sha256", this.storage.dataKey(file));
    mac.update(
      JSON.stringify([
        "segments-v1",
        file._id,
        file.objectId,
        file.size,
        file.chunkCount,
        file.storedSize,
      ]) + "\n",
    );
    let count = 0,
      offset = 0,
      stored = 0;
    for await (const part of this.chunks
      .find({ uploadId: file._id })
      .sort({ index: 1 })) {
      if (
        part.index !== count ||
        part.offset !== offset ||
        part.size < 1 ||
        part.size > file.chunkSize ||
        part.storedSize < 1
      )
        throw new Error("Invalid manifest sequence");
      mac.update(
        JSON.stringify([
          part.objectId,
          part.index,
          part.offset,
          part.size,
          part.storedSize,
          part.codec,
          part.sha256,
        ]) + "\n",
      );
      count++;
      offset += part.size;
      stored += part.storedSize;
    }
    if (
      count !== file.chunkCount ||
      offset !== file.size ||
      stored !== file.storedSize
    )
      throw new Error("Incomplete file manifest");
    return mac.digest("hex");
  }
  async verifyManifest(file) {
    const actual = await this.manifest(file);
    if (
      !/^[a-f\d]{64}$/.test(file.manifestMac) ||
      !crypto.timingSafeEqual(
        Buffer.from(actual, "hex"),
        Buffer.from(file.manifestMac, "hex"),
      )
    )
      throw new Error("File manifest authentication failed");
  }
  async *read(file, range = { start: 0, end: file.size - 1, length: file.size }, verified = false) {
    if (!verified) await this.verifyManifest(file);
    let delivered = 0;
    for await (const part of this.chunks
      .find({ uploadId: file._id, offset: { $gte: Math.max(0, range.start - 64 * 1024 * 1024 + 1), $lte: range.end } })
      .sort({ offset: 1 })) {
      if (part.offset + part.size <= range.start) continue;
      if (part.offset > range.start + delivered || part.size > 64 * 1024 * 1024)
        throw new Error('Invalid file sequence');
      const bytes = await this.storage.decrypt(part);
      const selected = bytes.subarray(Math.max(0, range.start - part.offset), Math.min(bytes.length, range.end - part.offset + 1));
      delivered += selected.length;
      if (delivered > range.length) throw new Error('File exceeds authenticated size');
      yield selected;
    }
    if (delivered !== range.length)
      throw new Error("Incomplete file stream");
  }
  async remove(file) {
    for await (const part of this.chunks.find({ uploadId: file._id })) {
      await this.storage.removeRecord(part);
      await this.chunks.deleteOne({ _id: part._id, objectId: part.objectId });
    }
  }
  async cleanup(pilot) {
    await this.uploads.updateMany(
      {
        status: { $in: ["uploading", "finalizing"] },
        expiresAt: { $lte: new Date() },
      },
      { $set: { status: "cancelling" } },
    );
    for await (const upload of this.uploads.find({
      status: "cancelling",
      $or: [
        { leaseUntil: { $exists: false } },
        { leaseUntil: { $lte: new Date() } },
      ],
    })) {
      if (await this.db.collection("transfers").findOne({ _id: upload._id })) {
        await this.uploads.updateOne(
          { _id: upload._id },
          { $set: { status: "complete" } },
        );
        continue;
      }
      await this.remove(upload);
      await pilot.release(upload.orgId, upload.reservationId);
      await this.uploads.updateOne(
        { _id: upload._id, status: "cancelling" },
        { $set: { status: "cancelled", cancelledAt: new Date() } },
      );
    }
  }
}
function resumableRoutes({
  app,
  db,
  config,
  storage,
  pilot,
  audit,
  email,
  idValid,
  capacity,
}) {
  const service = storage.segmented;
  const uploads = service.uploads,
    chunks = service.chunks;
  const summary = (row) => ({
    uploadId: row._id,
    offset: row.offset,
    size: row.size,
    chunkSize: row.chunkSize,
    status: row.status,
    compression: row.compression,
    purpose: row.purpose || 'send', profile: row.profile || 'documents', exportFormat: row.exportFormat || 'stc',
    expiresAt: row.expiresAt,
  });
  // Public resumable uploads have a fingerprint; internal restore stages do not.
  // The fingerprint constraint also protects stages created before the marker.
  const publicUpload = { internalRestore: { $ne: true }, fingerprint: { $type: "string" } };
  const owner = (req) => ({
    ...publicUpload,
    _id: req.params.id,
    owner: req.identity,
    orgId: req.org._id,
  });
  const writer = async (req) => {
    const org = await pilot.orgs.findOne({
      _id: req.org._id,
      status: "active",
      members: {
        $elemMatch: {
          email: req.identity,
          role: { $in: ["owner", "admin", "member"] },
        },
      },
    });
    if (!isActive(org))
      throw failure(403, "This workspace cannot upload files");
  };
  const result = (file) => ({
    fileId: file._id,
    shareUrl: `${config.baseUrl}/?transfer=${file._id}`,
    status: file.status,
    storedSize: file.storedSize,
    size: file.size,
    purpose: file.purpose || 'send',
  });
  app.get("/api/uploads", async (req, res) => {
    const rows = await uploads
      .find({
        ...publicUpload,
        owner: req.identity,
        orgId: req.org._id,
        status: { $in: ["uploading", "finalizing"] },
        expiresAt: { $gt: new Date() },
      })
      .sort({ createdAt: -1 })
      .limit(10)
      .toArray();
    res.json({
      uploads: rows.map((row) => ({
        ...summary(row),
        name: row.originalName,
        recipient: row.recipient,
        expiryHours: row.expiryHours,
      })),
    });
  });
  app.post("/api/uploads", async (req, res) => {
    await writer(req);
    const {
        name,
        size,
        fingerprint,
        resumeId,
        compression = "auto",
        purpose = 'send', profile = 'documents', exportFormat = 'stc',
        expiryHours = 24,
      } = req.body,
      recipient = purpose === 'send' ? email(req.body.recipient) : null;
    if (
      typeof name !== "string" ||
      !name ||
      name.length > 255 ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      size > Math.min(config.maxSize, config.scanMaxSize) ||
      (purpose === 'send' && !recipient) ||
      !['send','compress','restore'].includes(purpose) || !PROFILES.includes(profile) || !['stc','gzip'].includes(exportFormat) ||
      (purpose !== 'send' && req.body.recipient != null) ||
      typeof fingerprint !== "string" ||
      !/^[a-f\d]{64}$/.test(fingerprint) ||
      !["auto", "maximum", "none", "adaptive", "smallest", "research"].includes(compression) ||
      !Number.isInteger(expiryHours) ||
      expiryHours < 1 ||
      expiryHours > 168
    )
      throw failure(
        400,
        "Provide a file within the size limit, recipient and valid access settings",
      );
    if (resumeId !== undefined && !idValid(resumeId))
      throw failure(400, "Invalid upload to resume");
    const match = {
      ...publicUpload,
      ...(resumeId ? { _id: resumeId } : {}),
      owner: req.identity,
      orgId: req.org._id,
      fingerprint,
      status: { $in: ["uploading", "finalizing"] },
    };
    const existing = await uploads.findOne(match);
    if (resumeId && !existing)
      throw failure(
        400,
        "Choose the same unmodified original file to resume this upload",
      );
    if (existing) {
      if (+existing.expiresAt <= Date.now())
        throw failure(409, "This upload expired. Start a new transfer.");
      if (
        existing.originalName !== name ||
        existing.size !== size ||
        existing.recipient !== recipient ||
        existing.expiryHours !== expiryHours ||
        existing.compression !== compression || (existing.purpose || 'send') !== purpose || (existing.profile || 'documents') !== profile || (existing.exportFormat || 'stc') !== exportFormat
      )
        throw failure(
          409,
          "An unfinished upload of this file has different settings. Resume it with those settings or cancel it first.",
        );
      return res.json(summary(existing));
    }
    if (
      (await uploads.countDocuments({
        owner: req.identity,
        orgId: req.org._id,
        status: "uploading",
      })) >= 10
    )
      throw failure(
        409,
        "Finish or cancel an existing upload before starting another",
      );
    const reservationId = await pilot.reserve(req.org, size);
    if (!reservationId)
      throw failure(409, "Workspace storage or file quota reached");
    const id = crypto.randomUUID(),
      objectId = crypto.randomUUID();
    const record = {
      _id: id,
      objectId,
      format: "segments-v1",
      owner: req.identity,
      orgId: req.org._id,
      recipient,
      name:
        path
          .basename(name.replace(/\\/g, "/"))
          .replace(/[\x00-\x1f\x7f]/g, "")
          .slice(0, 200) || "download",
      originalName: name,
      size,
      fingerprint,
      compression,
      purpose, profile, exportFormat,
      expiryHours,
      offset: 0,
      chunkCount: 0,
      storedSize: 0,
      chunkSize: config.chunkSize,
      ...storage.wrap(crypto.randomBytes(32), objectId),
      reservationId,
      status: "uploading",
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 7 * 86400000),
    };
    try {
      await uploads.insertOne(record);
    } catch (error) {
      await pilot.release(req.org._id, reservationId);
      if (error.code !== 11000) throw error;
      return res.json(summary(await uploads.findOne(match)));
    }
    res.status(201).json(summary(record));
  });
  app.get("/api/uploads/:id", async (req, res) => {
    const row = idValid(req.params.id) && (await uploads.findOne(owner(req)));
    if (!row) throw failure(404, "Upload unavailable");
    res.json(summary(row));
  });
  app.delete("/api/uploads/:id", async (req, res) => {
    const row = idValid(req.params.id) && (await uploads.findOne(owner(req)));
    if (!row) throw failure(404, "Upload unavailable");
    if (["complete", "finalizing"].includes(row.status))
      throw failure(
        409,
        "This transfer is completing or complete. Finish it, then remove its access from Transfers.",
      );
    await uploads.updateOne(
      { ...owner(req), status: "uploading" },
      { $set: { status: "cancelling" } },
    );
    await service.cleanup(pilot);
    res.json({ success: true });
  });
  const lease = async (req, completing = false) => {
    await writer(req);
    if (!idValid(req.params.id)) throw failure(404, "Upload unavailable");
    const id = crypto.randomUUID();
    const row = await uploads.findOneAndUpdate(
      {
        ...owner(req),
        status: completing ? { $in: ["uploading", "finalizing"] } : "uploading",
        expiresAt: { $gt: new Date() },
        $or: [
          { leaseUntil: { $exists: false } },
          { leaseUntil: { $lte: new Date() } },
        ],
      },
      { $set: { lease: id, leaseUntil: new Date(Date.now() + 120000) } },
      { returnDocument: "after" },
    );
    if (!row)
      throw failure(
        409,
        "Upload is unavailable or another part is being processed. Retry shortly.",
      );
    return row;
  };
  app.put("/api/uploads/:id/chunks", capacity, async (req, res) => {
    const upload = await lease(req);
    let part,
      inserted = false;
    try {
      const rawOffset = req.get("Upload-Offset"),
        checksum = req.get("X-Chunk-SHA256");
      if (
        !/^\d{1,16}$/.test(rawOffset || "") ||
        !/^[a-f\d]{64}$/.test(checksum || "") ||
        !req.is("application/octet-stream")
      )
        throw failure(400, "Provide a chunk offset and SHA-256 checksum");
      const offset = Number(rawOffset);
      if (!Number.isSafeInteger(offset) || offset > upload.offset)
        throw failure(409, "Chunk offset does not match the saved upload");
      if(req.get('Content-Encoding') && req.get('Content-Encoding')!=='identity') throw failure(400,'Use an explicit chunk wire codec');
      await new Promise((resolve, reject) =>
        express.raw({
          type: "application/octet-stream",
          limit: Math.min(config.chunkSize,upload.size-offset),
          inflate: false,
        })(req, res, (error) => (error ? reject(error) : resolve())),
      );
      const wire = req.body;
      const wireCodec = req.get('X-Chunk-Codec') || 'none';
      const logicalLength = req.get('X-Chunk-Logical-Length');
      const expectedSize = Math.min(upload.chunkSize,upload.size-offset);
      if(req.get('Content-Encoding') && req.get('Content-Encoding')!=='identity' || logicalLength !== undefined && logicalLength!==String(expectedSize)) throw failure(400,'Invalid chunk transport settings');
      if(Buffer.isBuffer(wire))await uploads.updateOne({_id:upload._id,lease:upload.lease},{$inc:{wireReceivedBytes:wire.length}});
      const bytes = await decodeTransport(wire,{codec:wireCodec,expectedSize,sha256:checksum});
      if (
        !Buffer.isBuffer(bytes) ||
        bytes.length !== Math.min(upload.chunkSize, upload.size - offset) ||
        sha256(bytes) !== checksum
      )
        throw failure(400, "Chunk size or checksum does not match");
      if (offset < upload.offset) {
        const previous = await chunks.findOne({ uploadId: upload._id, offset });
        if (
          !previous ||
          previous.sha256 !== checksum ||
          previous.size !== bytes.length
        )
          throw failure(409, "Previously saved chunk differs from this retry");
        return res.json(summary(upload));
      }
      part = await chunks.findOne({
        uploadId: upload._id,
        index: upload.chunkCount,
      });
      if (
        part &&
        (part.offset !== offset ||
          part.sha256 !== checksum ||
          part.size !== bytes.length)
      )
        throw failure(409, "Previously saved chunk differs from this retry");
      if (!part) {
        part = await storage.writePart(
          { uploadId: upload._id, index: upload.chunkCount, offset },
          bytes,
          upload.compression,
        );
        const current = await uploads.findOne({
          _id: upload._id,
          status: "uploading",
          lease: upload.lease,
          leaseUntil: { $gt: new Date() },
        });
        if (!current) {
          await storage.removeRecord(part);
          part = null;
          throw failure(409, "Upload access changed. Retry after refreshing.");
        }
        await chunks.insertOne({
          _id: `${upload._id}:${upload.chunkCount}`,
          ...part,
        });
        inserted = true;
      }
      const changed = await uploads.updateOne(
        { _id: upload._id, status: "uploading", lease: upload.lease, offset },
        {
          $inc: {
            offset: bytes.length,
            chunkCount: 1,
            storedSize: part.storedSize,
          },
          $set: { updatedAt: new Date() },
        },
      );
      if (!changed.modifiedCount)
        throw failure(409, "Upload changed before this part was committed");
      res.json(summary({ ...upload, offset: offset + bytes.length }));
    } catch (error) {
      // A durable part survives a crash before offset advancement and is reused on retry.
      if (
        part &&
        !inserted &&
        !(await chunks.findOne({ objectId: part.objectId }))
      )
        await storage.removeRecord(part).catch(() => {});
      throw error;
    } finally {
      await uploads.updateOne(
        { _id: upload._id, lease: upload.lease },
        { $unset: { lease: "", leaseUntil: "" } },
      );
      req.releaseCapacity();
    }
  });
  async function recordCompletion(file) {
    await db.collection('usage').updateOne({ _id: `upload:${file._id}` }, { $setOnInsert: { orgId: file.orgId, type: 'upload', bytes: file.size, storedBytes: file.storedSize, fileId: file._id, at: file.createdAt } }, { upsert: true });
    await db.collection('audit').updateOne({ _id: `upload:${file._id}` }, { $setOnInsert: { action: 'UPLOAD', actor: file.owner, orgId: file.orgId, transferId: file._id, at: file.createdAt } }, { upsert: true });
    await uploads.updateOne({ _id: file._id }, { $set: { status: 'complete', completedAt: file.createdAt } });
  }
  app.post("/api/uploads/:id/complete", async (req, res) => {
    const existing =
      idValid(req.params.id) &&
      (await db
        .collection("transfers")
        .findOne({
          _id: req.params.id,
          restoreParentId: { $exists: false },
          owner: req.identity,
          orgId: req.org._id,
        }));
    if (existing) { await recordCompletion(existing); return res.json(result(existing)); }
    const upload = await lease(req, true);
    try {
      if (upload.offset !== upload.size)
        throw failure(409, "Upload is incomplete. Resume the remaining parts.");
      const file = {
        _id: upload._id,
        objectId: upload.objectId,
        format: upload.format,
        storageBackend: storage.driver,
        owner: upload.owner,
        orgId: upload.orgId,
        recipient: upload.recipient,
        name: upload.name,
        size: upload.size,
        storedSize: upload.storedSize,
        uploadPayloadBytes: upload.wireReceivedBytes || 0,
        compression: upload.compression,
        purpose: upload.purpose || 'send', profile: upload.profile || 'documents', exportFormat: upload.exportFormat || 'stc',
        chunkSize: upload.chunkSize,
        chunkCount: upload.chunkCount,
        version: upload.version,
        keyId: upload.keyId,
        wrappedKey: upload.wrappedKey,
        wrappingIv: upload.wrappingIv,
        wrappingTag: upload.wrappingTag,
        reservationId: upload.reservationId,
        status: "quarantined",
        downloads: 0,
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + upload.expiryHours * 3600000),
      };
      file.manifestMac = await service.manifest(file);
      await writer(req);
      const current = await uploads.findOneAndUpdate(
        {
          _id: upload._id,
          status: { $in: ["uploading", "finalizing"] },
          lease: upload.lease,
        },
        { $set: { status: "finalizing" } },
        { returnDocument: "after" },
      );
      if (!current)
        throw failure(409, "Upload was cancelled before completion");
      await db.collection("transfers").insertOne(file);
      await uploads.updateOne(
        { _id: upload._id },
        { $set: { status: "complete", completedAt: new Date() } },
      );
      await recordCompletion(file);
      res.status(201).json(result(file));
    } finally {
      await uploads.updateOne(
        { _id: upload._id, lease: upload.lease },
        { $unset: { lease: "", leaseUntil: "" } },
      );
    }
  });
}
module.exports = { Segments, resumableRoutes };
