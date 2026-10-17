const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const zlib = require("node:zlib");
const { MongoClient } = require("mongodb");
const { loadConfig } = require("../src/config");
const { Storage } = require("../src/storage");
const { initialize } = require("../src/database");
const { createApp } = require("../src/app");
const { archive, restore } = require("../src/compressed-archive");
const { shutdown } = require("../src/compression");
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
async function collect(source) {
  const chunks = [];
  for await (const bytes of source) chunks.push(bytes);
  return Buffer.concat(chunks);
}
async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "compression-"));
  const client = new MongoClient(
    process.env.TEST_MONGO_URI || "mongodb://mongo:27017",
  );
  await client.connect();
  const db = client.db("compression_" + crypto.randomBytes(8).toString("hex"));
  await initialize(db);
  const s3 = process.env.TEST_COMPRESSION_STORAGE === "s3";
  const config = {
    ...loadConfig({
      ...(s3 ? process.env : {}),
      ENCRYPTION_KEY: "12".repeat(32),
      OTP_SECRET: "34".repeat(32),
      MONGO_URI: "mongodb://mongo/test",
      SMTP_HOST: "mail",
      ...(s3 ? { STORAGE_DRIVER: "s3", S3_PREFIX: `${db.databaseName}/` } : {}),
    }),
    storage: root,
    chunkSize: 4096,
  };
  const storage = new Storage(config);
  await storage.init();
  const sent = [];
  const scanner = {
    async scanStream(source) {
      const bytes = await collect(source);
      return { clean: !bytes.includes(Buffer.from("EICAR-TEST")) };
    },
    async scan(bytes) {
      return { clean: !bytes.includes(Buffer.from("EICAR-TEST")) };
    },
  };
  const running = createApp({
    db,
    config,
    storage,
    scanner,
    mail: {
      async sendMail(message) {
        sent.push(message);
      },
    },
  });
  const server = running.app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    if (s3)
      for await (const object of storage.list())
        await storage.remove(object.id, object.backend);
    storage.close();
    await shutdown();
    await db.dropDatabase();
    await client.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const identity = "owner@example.com",
    token = crypto.randomBytes(32).toString("hex");
  await db.collection("sessions").insertOne({
    _id: hash(token),
    email: identity,
    expiresAt: new Date(Date.now() + 3600000),
  });
  const org = await running.pilot.createTeam(identity, "Compression tests");
  const headers = {
      Authorization: `Bearer ${token}`,
      "X-Organization-ID": org._id,
    },
    base = `http://127.0.0.1:${server.address().port}`;
  const request = (url, method = "GET", body, extra = {}) =>
    fetch(base + url, {
      method,
      headers: {
        ...headers,
        ...(body && !Buffer.isBuffer(body)
          ? { "Content-Type": "application/json" }
          : {}),
        ...extra,
      },
      body: body
        ? Buffer.isBuffer(body)
          ? body
          : JSON.stringify(body)
        : undefined,
      redirect: "manual",
    });
  const upload = async (bytes, settings = {}) => {
    const settingsAll = {
      name: "records.txt",
      size: bytes.length,
      fingerprint: crypto.randomBytes(32).toString("hex"),
      compression: "adaptive",
      recipient: identity,
      ...settings,
    };
    if (settings.purpose && settings.purpose !== "send")
      delete settingsAll.recipient;
    const response = await request("/api/uploads", "POST", settingsAll);
    assert.equal(response.status, 201, await response.clone().text());
    const saved = await response.json();
    for (let offset = 0; offset < bytes.length; offset += saved.chunkSize) {
      const plain = bytes.subarray(offset, offset + saved.chunkSize),
        wire = zlib.gzipSync(plain);
      const use = wire.length < plain.length;
      const r = await request(
        `/api/uploads/${saved.uploadId}/chunks`,
        "PUT",
        use ? wire : plain,
        {
          "Content-Type": "application/octet-stream",
          "Upload-Offset": String(offset),
          "X-Chunk-SHA256": hash(plain),
          "X-Chunk-Codec": use ? "gzip" : "none",
          "X-Chunk-Logical-Length": String(plain.length),
        },
      );
      assert.equal(r.status, 200, await r.clone().text());
    }
    const completed = await request(
      `/api/uploads/${saved.uploadId}/complete`,
      "POST",
      {},
    );
    assert.ok(
      [200, 201].includes(completed.status),
      await completed.clone().text(),
    );
    return completed.json();
  };
  return {
    db,
    storage,
    running,
    headers,
    base,
    request,
    upload,
    org,
    sent,
    config,
    token,
  };
}
test("private compression jobs accept compressed chunks without recipients or mail and retain exact originals", async (t) => {
  const c = await setup(t),
    original = Buffer.from("Private company records.\n".repeat(800));
  const file = await c.upload(original, {
    purpose: "compress",
    profile: "documents",
    exportFormat: "stc",
  });
  assert.equal(
    (await c.request(`/api/file/${file.fileId}/export/stc`)).status,
    404,
  );
  await c.running.worker.tick();
  const row = await c.db.collection("transfers").findOne({ _id: file.fileId });
  assert.equal(row.recipient, null);
  assert.equal(row.purpose, "compress");
  assert.equal(row.status, "active");
  assert.equal(row.notification, undefined);
  assert.equal(c.sent.length, 0);
  const downloaded = await c.request(`/api/file/${file.fileId}/download`);
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), original);
  const packed = await c.request(`/api/file/${file.fileId}/export/stc`);
  assert.equal(packed.status, 200);
  assert.equal(packed.headers.get("accept-ranges"), null);
  const opened = await restore(packed.body, {
    maxOutputBytes: original.length,
  });
  assert.deepEqual(await collect(opened.stream), original);
  const gzip = await c.request(`/api/file/${file.fileId}/export/gzip`);
  assert.deepEqual(
    zlib.gunzipSync(Buffer.from(await gzip.arrayBuffer())),
    original,
  );
  const info = await (
    await c.request(`/api/file/${file.fileId}/compression`)
  ).json();
  assert.equal(info.originalBytes, original.length);
  assert.ok(
    info.uploadPayloadBytes < original.length,
    "Server measures received compressed upload payload separately",
  );
  assert.ok(info.exports.stc.completedBytes > 0);
  assert.ok(info.codecCounts.length);
  const analytics = await (await c.request("/api/analytics")).json();
  assert.ok(analytics.totals.exportBytes > 0);
  assert.equal(analytics.totals.exports, 2);
  assert.equal(
    (
      await c.request(`/api/file/${file.fileId}/export/stc`, "GET", undefined, {
        Range: "bytes=0-10",
      })
    ).status,
    416,
  );
});

test("restore retries scanner failure with the same parts and releases all quota on cancellation", async (t) => {
  const c = await setup(t),
    original = Buffer.from("recoverable record\n".repeat(4000));
  const input = await collect(
    archive([original], { name: "recovered.txt", size: original.length }),
  );
  const file = await c.upload(input, { purpose: "restore" }),
    inspector = c.running.worker.scanner;
  c.running.worker.scanner = {
    async scanStream(source) {
      await collect(source);
      throw new Error("Temporary scanner outage");
    },
  };
  await c.running.worker.tick();
  const waiting = await c.db
    .collection("transfers")
    .findOne({ _id: file.fileId });
  assert.equal(waiting.status, "quarantined");
  const parts = await c.db
    .collection("chunks")
    .countDocuments({ uploadId: waiting.restoredFileId });
  assert.ok(parts > 0);
  const before = await c.db
    .collection("organizations")
    .findOne({ _id: c.org._id });
  c.running.worker.scanner = inspector;
  await c.db
    .collection("transfers")
    .updateOne({ _id: file.fileId }, { $set: { scanRetryAt: new Date(0) } });
  await c.running.worker.tick();
  const ready = await c.db
    .collection("transfers")
    .findOne({ _id: file.fileId });
  assert.equal(ready.status, "active");
  assert.equal(
    await c.db
      .collection("chunks")
      .countDocuments({ uploadId: ready.restoredFileId }),
    parts,
  );
  assert.equal(
    (await c.db.collection("organizations").findOne({ _id: c.org._id }))
      .usedBytes,
    before.usedBytes,
  );
  const canceled = await c.upload(input, { purpose: "restore" }),
    write = c.storage.writePart.bind(c.storage);
  let interrupted = false;
  c.storage.writePart = async (context, bytes, mode) => {
    const part = await write(context, bytes, mode);
    if (!interrupted && context.uploadId !== canceled.fileId) {
      interrupted = true;
      await c.db
        .collection("transfers")
        .updateOne({ _id: canceled.fileId }, { $set: { status: "deleting" } });
      await c.running.cleanup();
    }
    return part;
  };
  await c.running.worker.tick();
  c.storage.writePart = write;
  await c.running.cleanup();
  const parent = await c.db
    .collection("transfers")
    .findOne({ _id: canceled.fileId });
  assert.equal(parent.status, "deleted");
  assert.equal(
    await c.db
      .collection("chunks")
      .countDocuments({ uploadId: parent.restoredFileId }),
    0,
  );
  assert.equal(
    (await c.db.collection("organizations").findOne({ _id: c.org._id }))
      .usedBytes,
    before.usedBytes,
  );
});
test("native export grants bind a representation and fail on logout, expiry and different workspaces", async (t) => {
  const c = await setup(t),
    original = Buffer.from("Shared data\n".repeat(100));
  const file = await c.upload(original);
  await c.running.worker.tick();
  const ticket = await (
    await c.request(`/api/file/${file.fileId}/download-ticket`, "POST", {
      representation: "stc",
    })
  ).json();
  const handoff = await fetch(c.base + ticket.url, { redirect: "manual" });
  assert.equal(handoff.status, 302);
  const cookie = handoff.headers.get("set-cookie").split(";")[0],
    url = handoff.headers.get("location");
  assert.ok(url.endsWith("/stc"));
  const download = await fetch(c.base + url, { headers: { Cookie: cookie } });
  assert.equal(download.status, 200);
  assert.ok(download.headers.get("content-disposition").includes(".stc"));
  await download.arrayBuffer();
  assert.equal(
    (
      await fetch(c.base + `/api/download/${file.fileId}/gzip`, {
        headers: { Cookie: cookie },
      })
    ).status,
    401,
  );
  const other = await c.running.pilot.createTeam(
    "outsider@example.com",
    "Other workspace",
  );
  const otherToken = crypto.randomBytes(32).toString("hex");
  await c.db.collection("sessions").insertOne({
    _id: hash(otherToken),
    email: "outsider@example.com",
    expiresAt: new Date(Date.now() + 3600000),
  });
  assert.equal(
    (
      await c.request(`/api/file/${file.fileId}/export/stc`, "GET", undefined, {
        Authorization: `Bearer ${otherToken}`,
        "X-Organization-ID": other._id,
      })
    ).status,
    404,
  );
  await c.request("/api/logout", "POST", {});
  assert.equal(
    (await fetch(c.base + url, { headers: { Cookie: cookie } })).status,
    401,
  );
});
test("restore validates the complete archive then scans reconstructed bytes and recovers without duplicate quota", async (t) => {
  const c = await setup(t),
    original = Buffer.from("Exact restored bytes.\n".repeat(1000));
  const input = await collect(
    archive([original], {
      name: "restored.txt",
      size: original.length,
      mode: "research",
    }),
  );
  const file = await c.upload(input, {
    purpose: "restore",
    profile: "archives",
  });
  await c.running.worker.tick();
  const parent = await c.db
    .collection("transfers")
    .findOne({ _id: file.fileId });
  assert.equal(parent.status, "active");
  assert.ok(parent.restoredFileId);
  const child = await c.db
    .collection("transfers")
    .findOne({ _id: parent.restoredFileId });
  assert.equal(child.status, "active");
  assert.equal(child.name, "restored.txt");
  assert.equal(child.recipient, null);
  const downloaded = await c.request(`/api/file/${child._id}/download`);
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), original);
  const before = await c.db
    .collection("organizations")
    .findOne({ _id: c.org._id });
  await c.running.worker.tick();
  const after = await c.db
    .collection("organizations")
    .findOne({ _id: c.org._id });
  assert.equal(after.usedBytes, before.usedBytes);
  assert.equal(c.sent.length, 0);
  const malicious = Buffer.from(input);
  malicious[malicious.length - 1] ^= 128;
  const invalid = await c.upload(malicious, { purpose: "restore" });
  await c.running.worker.tick();
  assert.equal(
    (await c.db.collection("transfers").findOne({ _id: invalid.fileId }))
      .status,
    "blocked",
  );
  const infected = Buffer.from("EICAR-TEST");
  const dangerous = await collect(
    archive([infected], { name: "infected.txt", size: infected.length }),
  );
  const blocked = await c.upload(dangerous, { purpose: "restore" });
  await c.running.worker.tick();
  assert.equal(
    (await c.db.collection("transfers").findOne({ _id: blocked.fileId }))
      .status,
    "blocked",
  );
});
test("a published restore repairs interrupted usage and audit recording exactly once", async (t) => {
  const c = await setup(t);
  const original = Buffer.from("Recover completion accounting.\n".repeat(300));
  const input = await collect(
    archive([original], { name: "accounting.txt", size: original.length }),
  );
  const file = await c.upload(input, { purpose: "restore" });
  const collection = c.db.collection.bind(c.db);
  let interrupted = false;
  c.db.collection = (name, ...args) => {
    const result = collection(name, ...args);
    if (name === "usage") {
      const update = result.updateOne.bind(result);
      result.updateOne = async (...values) => {
        if (!interrupted) {
          interrupted = true;
          throw new Error("Temporary accounting outage");
        }
        return update(...values);
      };
    }
    return result;
  };
  await c.running.worker.tick();
  c.db.collection = collection;
  const parent = await collection("transfers").findOne({ _id: file.fileId });
  assert.equal(parent.restoreState, "complete");
  await c.running.worker.maintain();
  await c.running.worker.maintain();
  assert.equal(
    await collection("usage").countDocuments({
      _id: `upload:${parent.restoredFileId}`,
    }),
    1,
  );
  assert.equal(
    await collection("audit").countDocuments({ _id: `restore:${file.fileId}` }),
    1,
  );
  assert.equal(
    (await collection("transfers").findOne({ _id: file.fileId }))
      .restoreRecorded,
    true,
  );
});
