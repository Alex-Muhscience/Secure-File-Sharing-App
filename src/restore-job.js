const crypto = require("node:crypto");
const { restore, ArchiveError } = require("./compressed-archive");
const { PLANS, isActive } = require("./pilot");
const { sha256 } = require("./parts");
function stageId(parentId) {
  const h = crypto
    .createHash("sha256")
    .update("restore:" + parentId)
    .digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
async function restoreJob(worker, parent) {
  const { db, storage, config } = worker,
    files = db.collection("transfers"),
    uploads = db.collection("uploads"),
    chunks = db.collection("chunks");
  const id = stageId(parent._id),
    lease = parent.scanLease;
  let renewal, opened;
  const alive = async () => {
    const [current, stage] = await Promise.all([
      files.findOne({
        _id: parent._id,
        status: "quarantined",
        scanLease: lease,
        expiresAt: { $gt: new Date() },
      }),
      uploads.findOne({
        _id: id,
        status: "finalizing",
        lease,
        leaseUntil: { $gt: new Date() },
      }),
    ]);
    if (!current || !stage) throw new Error("Restore access or lease changed");
  };
  const publish = async (child) => {
    const changed = await files.updateOne(
      {
        _id: parent._id,
        status: "quarantined",
        scanLease: lease,
        expiresAt: { $gt: new Date() },
      },
      {
        $set: {
          status: "active",
          scanResult: "clean",
          scannedAt: new Date(),
          restoredFileId: id,
          restoreState: "complete",
          restoreRecorded: false,
        },
        $unset: {
          scanLease: "",
          scanLeaseUntil: "",
          scanRetryAt: "",
          restoreError: "",
        },
      },
    );
    if (!changed.modifiedCount) {
      await files.updateOne(
        { _id: id, status: "quarantined", pendingRestoreParent: parent._id },
        { $set: { status: "deleting" } },
      );
      await uploads.updateOne(
        { _id: id, status: "finalizing" },
        { $set: { status: "cancelling" } },
      );
      throw new Error("Restore was canceled before publication");
    }
    await recordCompletion(worker, parent, child);
  };
  try {
    const existing = await files.findOne({
      _id: id,
      restoreParentId: parent._id,
    });
    if (
      existing?.restoreVerified &&
      ["quarantined", "active"].includes(existing.status)
    ) {
      await publish(existing);
      return;
    }
    opened = await restore(storage.plaintext(parent), {
      maxOutputBytes: Math.min(config.maxSize, config.scanMaxSize),
    });
    if (
      !(await files.findOne({
        _id: parent._id,
        status: "quarantined",
        scanLease: lease,
        expiresAt: { $gt: new Date() },
      }))
    )
      throw new Error("Restore was canceled before allocation");
    let stage = await uploads.findOne({ _id: id });
    if (!stage) {
      const org = await db
        .collection("organizations")
        .findOne({ _id: parent.orgId });
      if (
        !isActive(org) ||
        !org.members.some(
          (member) =>
            member.email === parent.owner &&
            ["owner", "admin", "member"].includes(member.role),
        )
      )
        throw new Error("Workspace cannot allocate restored storage");
      const reservationId = await worker.pilot.reserve(
        {
          ...org,
          actorEmail: parent.owner,
          limits: PLANS[org.plan] || PLANS.pilot,
        },
        opened.metadata.size,
      );
      if (!reservationId)
        throw Object.assign(
          new Error("Restore requires space for both archive and original"),
          { restoreQuota: true },
        );
      const objectId = crypto.randomUUID();
      stage = {
        _id: id,
        objectId,
        owner: parent.owner,
        orgId: parent.orgId,
        reservationId,
        format: "segments-v1",
        purpose: "compress",
        profile: parent.profile || "documents",
        size: opened.metadata.size,
        name: opened.metadata.name,
        status: "finalizing",
        chunkSize: config.chunkSize,
        offset: 0,
        chunkCount: 0,
        storedSize: 0,
        expiresAt: parent.expiresAt,
        createdAt: new Date(),
        ...storage.wrap(crypto.randomBytes(32), objectId),
      };
      try {
        await uploads.insertOne(stage);
      } catch (error) {
        await worker.pilot.release(parent.orgId, reservationId);
        if (error.code !== 11000) throw error;
        stage = await uploads.findOne({ _id: id });
      }
    }
    stage = await uploads.findOneAndUpdate(
      {
        _id: id,
        status: "finalizing",
        $or: [
          { lease: lease },
          { leaseUntil: { $exists: false } },
          { leaseUntil: { $lte: new Date() } },
        ],
      },
      { $set: { lease, leaseUntil: new Date(Date.now() + 120000) } },
      { returnDocument: "after" },
    );
    if (!stage) throw new Error("Restore stage unavailable");
    const marked = await files.updateOne(
      { _id: parent._id, status: "quarantined", scanLease: lease },
      { $set: { restoredFileId: id } },
    );
    if (!marked.matchedCount) {
      await uploads.updateOne(
        { _id: id, lease },
        { $set: { status: "cancelling" } },
      );
      throw new Error("Restore was canceled during allocation");
    }
    renewal = setInterval(
      () =>
        uploads
          .updateOne(
            { _id: id, status: "finalizing", lease },
            { $set: { leaseUntil: new Date(Date.now() + 120000) } },
          )
          .catch(() => {}),
      20000,
    );
    renewal.unref();
    let index = 0,
      offset = 0,
      storedSize = 0;
    for await (const decoded of opened.stream) {
      for (let start = 0; start < decoded.length; start += config.chunkSize) {
        await alive();
        const bytes = decoded.subarray(start, start + config.chunkSize),
          hash = sha256(bytes);
        let part = await chunks.findOne({ uploadId: id, index });
        if (part) {
          if (
            part.size !== bytes.length ||
            part.offset !== offset ||
            part.sha256 !== hash
          )
            throw new ArchiveError("Restored part changed across recovery");
        } else {
          part = await storage.writePart(
            { uploadId: id, index, offset },
            bytes,
            "adaptive",
          );
          try {
            await alive();
            await chunks.insertOne({ _id: `${id}:${index}`, ...part });
          } catch (error) {
            await storage.removeRecord(part).catch(() => {});
            throw error;
          }
        }
        index++;
        offset += bytes.length;
        storedSize += part.storedSize;
        await uploads.updateOne(
          { _id: id, status: "finalizing", lease },
          { $set: { offset, chunkCount: index, storedSize } },
        );
      }
    }
    if (offset !== opened.metadata.size)
      throw new ArchiveError("Incomplete reconstructed file");
    await alive();
    const child = {
      _id: id,
      objectId: stage.objectId,
      format: "segments-v1",
      storageBackend: storage.driver,
      owner: parent.owner,
      orgId: parent.orgId,
      recipient: null,
      name: stage.name,
      size: stage.size,
      storedSize,
      compression: "adaptive",
      purpose: "compress",
      profile: stage.profile,
      exportFormat: "stc",
      chunkSize: config.chunkSize,
      chunkCount: index,
      version: stage.version,
      keyId: stage.keyId,
      wrappedKey: stage.wrappedKey,
      wrappingIv: stage.wrappingIv,
      wrappingTag: stage.wrappingTag,
      reservationId: stage.reservationId,
      status: "quarantined",
      downloads: 0,
      createdAt: new Date(),
      expiresAt: parent.expiresAt,
      restoreParentId: parent._id,
      pendingRestoreParent: parent._id,
    };
    child.manifestMac = await storage.segmented.manifest(child);
    async function* guarded() {
      for await (const bytes of storage.plaintext(child)) {
        await alive();
        yield bytes;
      }
    }
    const inspected = await worker.scanner.scanStream(guarded(), {
      size: child.size,
      fileId: id,
    });
    await alive();
    if (!inspected.clean) {
      await files.updateOne(
        { _id: parent._id, status: "quarantined", scanLease: lease },
        {
          $set: {
            status: "blocked",
            scanResult: "infected",
            blockedAt: new Date(),
            restoreError: "The restored original failed inspection.",
          },
          $unset: { scanLease: "", scanLeaseUntil: "" },
        },
      );
      await uploads.updateOne(
        { _id: id, lease },
        { $set: { status: "cancelling" } },
      );
      return;
    }
    Object.assign(child, {
      restoreVerified: true,
      scanResult: "clean",
      scannedAt: new Date(),
    });
    try {
      await files.insertOne(child);
    } catch (error) {
      if (error.code !== 11000) throw error;
    }
    await alive();
    await publish(child);
  } catch (error) {
    if (error instanceof ArchiveError) {
      await files.updateOne(
        { _id: parent._id, status: "quarantined", scanLease: lease },
        {
          $set: {
            status: "blocked",
            scanResult: "invalid_archive",
            blockedAt: new Date(),
            restoreError:
              "The archive is invalid, incomplete or exceeds the restore limit.",
          },
          $unset: { scanLease: "", scanLeaseUntil: "" },
        },
      );
      await uploads.updateOne(
        { _id: id, lease },
        { $set: { status: "cancelling" } },
      );
    } else {
      await files.updateOne(
        { _id: parent._id, status: "quarantined", scanLease: lease },
        {
          $set: {
            scanRetryAt: new Date(Date.now() + 30000),
            restoreError: error.restoreQuota
              ? "Storage is needed for both the archive and restored original. Free space and retry."
              : "Restore paused; saved encrypted parts will be retried.",
          },
          $unset: { scanLease: "", scanLeaseUntil: "" },
        },
      );
      throw error;
    }
  } finally {
    clearInterval(renewal);
    await opened?.stream.return?.();
    await uploads.updateOne(
      { _id: id, lease },
      { $unset: { lease: "", leaseUntil: "" } },
    );
  }
}
async function recordCompletion(worker, parent, child) {
  const { db } = worker;
  if (parent.status !== "active") {
    parent = await db.collection("transfers").findOne({ _id: parent._id });
  }
  if (parent?.status === "active" && parent.expiresAt > new Date()) {
    await db
      .collection("transfers")
      .updateOne(
        {
          _id: child._id,
          status: "quarantined",
          pendingRestoreParent: parent._id,
        },
        {
          $set: { status: "active" },
          $unset: {
            pendingRestoreParent: "",
            scanLease: "",
            scanLeaseUntil: "",
          },
        },
      );
  }
  await db
    .collection("uploads")
    .updateOne(
      { _id: child._id, status: "finalizing" },
      { $set: { status: "complete" } },
    );
  await db
    .collection("usage")
    .updateOne(
      { _id: `upload:${child._id}` },
      {
        $setOnInsert: {
          orgId: child.orgId,
          type: "upload",
          bytes: child.size,
          storedBytes: child.storedSize,
          fileId: child._id,
          at: child.createdAt,
        },
      },
      { upsert: true },
    );
  await db
    .collection("audit")
    .updateOne(
      { _id: `restore:${parent._id}` },
      {
        $setOnInsert: {
          action: "RESTORE",
          actor: parent.owner,
          orgId: parent.orgId,
          transferId: child._id,
          at: parent.scannedAt || new Date(),
        },
      },
      { upsert: true },
    );
  await db
    .collection("transfers")
    .updateOne(
      { _id: parent._id, restoreState: "complete", restoredFileId: child._id },
      { $set: { restoreRecorded: true } },
    );
}
async function repairCompletions(worker) {
  for await (const parent of worker.db
    .collection("transfers")
    .find({
      restoreState: "complete",
      restoreRecorded: false,
    })
    .limit(20)) {
    const child = await worker.db.collection("transfers").findOne({
      _id: parent.restoredFileId,
      restoreParentId: parent._id,
      restoreVerified: true,
    });
    if (child) await recordCompletion(worker, parent, child);
  }
}
module.exports = { restoreJob, stageId, repairCompletions };
