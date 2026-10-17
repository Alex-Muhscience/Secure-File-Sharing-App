const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { MongoClient } = require("mongodb");
const { loadConfig } = require("../src/config");
const { Storage } = require("../src/storage");
const { initialize } = require("../src/database");
const { createApp } = require("../src/app");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const execute = promisify(execFile);
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
test("resumable encrypted uploads survive retries and process replacement, remain isolated, and reject missing or reordered parts", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "resumable-"));
  const client = new MongoClient(
      process.env.TEST_MONGO_URI || "mongodb://mongo:27017",
    ),
    db = client.db(`resumable_${crypto.randomBytes(6).toString("hex")}`);
  const restoredName = `restore_${db.databaseName}`;
  let server;
  t.after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    await db.dropDatabase();
    await client.db(restoredName).dropDatabase();
    await client.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  await client.connect();
  await initialize(db);
  const config = {
    ...loadConfig({
      ENCRYPTION_KEY: "12".repeat(32),
      OTP_SECRET: "34".repeat(32),
      MONGO_URI: "mongodb://mongo/test",
      SMTP_HOST: "mail",
      MAX_FILE_SIZE: String(5 * 1024 ** 4),
    }),
    storage: path.join(directory, "objects"),
    chunkSize: 1024,
  };
  const storage = new Storage(config);
  await storage.init();
  const sent = [],
    scanner = {
      async scan(bytes) {
        assert.ok(Buffer.isBuffer(bytes));
        return { clean: true };
      },
      async scanStream(source) {
        let size = 0;
        for await (const chunk of source) size += chunk.length;
        assert.ok(size > 0);
        return { clean: true };
      },
    };
  let running = createApp({
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
  server = running.app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (url, token, org, method = "GET", body, headers = {}) =>
    fetch(base + url, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(org ? { "X-Organization-ID": org } : {}),
        ...(body && !Buffer.isBuffer(body)
          ? { "Content-Type": "application/json" }
          : {}),
        ...headers,
      },
      body: body
        ? Buffer.isBuffer(body)
          ? body
          : JSON.stringify(body)
        : undefined,
    });
  const login = async (email) => {
    const challenge = await (
      await request("/api/request-otp", null, null, "POST", { email })
    ).json();
    return (
      await (
        await request("/api/verify-otp", null, null, "POST", {
          sessionId: challenge.sessionId,
          otp: sent.at(-1).text.match(/\b\d{6}\b/)[0],
        })
      ).json()
    ).token;
  };
  const owner = await login("owner@example.com"),
    other = await login("other@example.com");
  const org = await running.pilot.createTeam(
    "owner@example.com",
    "Large files",
  );
  const plain = Buffer.from(
    "File content repeated for compression.\n".repeat(100),
  );
  const input = {
    name: "Large project.txt",
    size: plain.length,
    recipient: "owner@example.com",
    expiryHours: 24,
    compression: "auto",
    fingerprint: "ab".repeat(32),
  };
  let response = await request("/api/uploads", owner, org._id, "POST", input);
  assert.equal(response.status, 201, await response.clone().text());
  const upload = await response.json(),
    route = `/api/uploads/${upload.uploadId}`;
  assert.equal(upload.offset, 0);
  assert.equal(upload.chunkSize, 1024);
  const duplicate = await (
    await request("/api/uploads", owner, org._id, "POST", input)
  ).json();
  assert.equal(duplicate.uploadId, upload.uploadId);
  assert.equal(
    (await db.collection("organizations").findOne({ _id: org._id })).fileCount,
    1,
  );
  assert.equal((await request(route, other, org._id)).status, 404);
  assert.equal(
    (await request(route + "/complete", owner, org._id, "POST", {})).status,
    409,
  );
  const sendPart = (
    offset,
    bytes = plain.subarray(offset, offset + 1024),
    checksum = hash(bytes),
  ) =>
    request(route + "/chunks", owner, org._id, "PUT", bytes, {
      "Content-Type": "application/octet-stream",
      "Upload-Offset": String(offset),
      "X-Chunk-SHA256": checksum,
    });
  assert.equal((await sendPart(1024)).status, 409);
  assert.equal((await sendPart(0, undefined, "00".repeat(32))).status, 400);
  assert.equal((await sendPart(0)).status, 200);
  assert.equal((await sendPart(0)).status, 200);
  await db
    .collection("uploads")
    .updateOne(
      { _id: upload.uploadId },
      { $set: { offset: 0, chunkCount: 0, storedSize: 0 } },
    );
  assert.equal(
    (await sendPart(0)).status,
    200,
    "A persisted part is recovered if the process stopped before advancing its offset",
  );
  assert.equal(
    await db.collection("chunks").countDocuments({ uploadId: upload.uploadId }),
    1,
  );
  // A different process reads the persisted offset; no in-memory upload state is required.
  const replacement = new Storage(config);
  replacement.attach(db);
  assert.equal(
    (await (await request(route, owner, org._id)).json()).offset,
    1024,
  );
  for (let offset = 1024; offset < plain.length; offset += 1024)
    assert.equal((await sendPart(offset)).status, 200);
  await db
    .collection("uploads")
    .updateOne({ _id: upload.uploadId }, { $set: { status: "finalizing" } });
  assert.equal((await request(route, owner, org._id, "DELETE")).status, 409);
  const completed = await (
    await request(route + "/complete", owner, org._id, "POST", {})
  ).json();
  assert.equal(completed.status, "quarantined");
  assert.equal(
    (
      await (
        await request(route + "/complete", owner, org._id, "POST", {})
      ).json()
    ).fileId,
    completed.fileId,
  );
  const file = await db
    .collection("transfers")
    .findOne({ _id: completed.fileId });
  assert.equal(file.format, "segments-v1");
  assert.ok(file.storedSize < file.size);
  await db.collection('usage').deleteOne({ _id: `upload:${file._id}` });
  await db.collection('audit').deleteOne({ _id: `upload:${file._id}` });
  assert.equal((await request(route + '/complete', owner, org._id, 'POST', {})).status, 200);
  assert.equal(await db.collection('usage').countDocuments({ _id: `upload:${file._id}` }), 1, 'Completion retry repairs accounting after a metadata commit');
  assert.deepEqual(await replacement.decrypt(file), plain);
  assert.equal(
    (await request(`/api/file/${file._id}/download`, owner, org._id)).status,
    404,
  );
  await running.worker.tick();
  const downloaded = await request(
    `/api/file/${file._id}/download`,
    owner,
    org._id,
  );
  assert.equal(downloaded.status, 200);
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), plain);
  const nativeToken = crypto.randomBytes(32).toString('hex');
  await db.collection('sessions').insertOne({ _id: hash(nativeToken), email: 'owner@example.com', expiresAt: new Date(Date.now() + 3600000) });
  const ticket = await (
    await request(
      `/api/file/${file._id}/download-ticket`,
      nativeToken,
      org._id,
      "POST",
      {},
    )
  ).json();
  assert.match(ticket.url, /^\/api\/download\/[a-f\d]{64}$/);
  const handoff = await fetch(base + ticket.url, { redirect: 'manual' });
  assert.equal(handoff.status, 302, 'A one-use ticket creates a file-scoped download grant');
  const cookie = handoff.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Strict/i);
  const nativeUrl = handoff.headers.get('location');
  assert.equal(nativeUrl, `/api/download/${file._id}`);
  const nativeHeaders = { Cookie: cookie.split(';')[0] };
  assert.equal((await request(nativeUrl)).status, 401);
  const native = await request(nativeUrl, null, null, 'GET', null, nativeHeaders);
  assert.equal(native.status, 200);
  assert.deepEqual(Buffer.from(await native.arrayBuffer()), plain);
  for (const [header, start, end] of [['bytes=4-9', 4, 9], ['bytes=1000-1049', 1000, 1049], ['bytes=-10', plain.length - 10, plain.length - 1]]) {
    const resumed = await request(nativeUrl, null, null, 'GET', null, { ...nativeHeaders, Range: header });
    assert.equal(resumed.status, 206);
    assert.equal(resumed.headers.get('content-range'), `bytes ${start}-${end}/${plain.length}`);
    assert.deepEqual(Buffer.from(await resumed.arrayBuffer()), plain.subarray(start, end + 1));
  }
  const invalid = await request(nativeUrl, null, null, 'GET', null, { ...nativeHeaders, Range: `bytes=${plain.length}-` });
  assert.equal(invalid.status, 416);
  assert.equal(invalid.headers.get('content-range'), `bytes */${plain.length}`);
  assert.equal(
    (await request(ticket.url)).status,
    401,
    "Native download tickets are single-use",
  );
  // Download-only grants survive ordinary sign-in expiry but explicit logout revokes them.
  await db.collection('sessions').updateOne({ _id: hash(nativeToken) }, { $set: { expiresAt: new Date(0) } });
  assert.equal((await request(nativeUrl, null, null, 'GET', null, { ...nativeHeaders, Range: 'bytes=0-9' })).status, 206);
  assert.equal((await request('/api/logout', nativeToken, null, 'POST', {})).status, 200);
  assert.equal((await request(nativeUrl, null, null, 'GET', null, nativeHeaders)).status, 401);
  const part = await db
    .collection("chunks")
    .findOne({ uploadId: file._id, index: 0 });
  await db
    .collection("chunks")
    .updateOne({ _id: part._id }, { $set: { index: 90 } });
  await assert.rejects(replacement.verify(file), /manifest|sequence/);
  await db
    .collection("chunks")
    .updateOne({ _id: part._id }, { $set: { index: 0 } });
  await db.collection("chunks").deleteOne({ _id: part._id });
  await assert.rejects(replacement.verify(file), /manifest|sequence/);
  await db.collection("chunks").insertOne(part);
  const sourceUri = new URL(
    process.env.TEST_MONGO_URI || "mongodb://mongo:27017",
  );
  sourceUri.pathname = `/${db.databaseName}`;
  const archive = path.join(directory, "segments.enc"),
    backupScript = path.join(__dirname, "../scripts/backup.cjs");
  const backupEnv = {
    ...process.env,
    ENCRYPTION_KEY: "12".repeat(32),
    OTP_SECRET: "34".repeat(32),
    BACKUP_KEY: "56".repeat(32),
    MONGO_URI: sourceUri.toString(),
    SMTP_HOST: "mail",
    STORAGE_DRIVER: "filesystem",
    S3_ENDPOINT: "",
    STORAGE_DIR: config.storage,
  };
  await execute(process.execPath, [backupScript, "create", archive], {
    env: backupEnv,
  });
  const restoredDir = path.join(directory, "restored");
  await execute(
    process.execPath,
    [backupScript, "restore", archive, restoredName],
    { env: { ...backupEnv, STORAGE_DIR: restoredDir } },
  );
  const restoredStorage = new Storage({ ...config, storage: restoredDir });
  restoredStorage.attach(client.db(restoredName));
  assert.deepEqual(
    await restoredStorage.decrypt(
      await client
        .db(restoredName)
        .collection("transfers")
        .findOne({ _id: file._id }),
    ),
    plain,
  );
  const cancel = await (
    await request("/api/uploads", owner, org._id, "POST", {
      ...input,
      fingerprint: "cd".repeat(32),
    })
  ).json();
  assert.equal(
    (await request(`/api/uploads/${cancel.uploadId}`, owner, org._id, "DELETE"))
      .status,
    200,
  );
  assert.equal(
    (await db.collection("organizations").findOne({ _id: org._id })).fileCount,
    1,
  );
  assert.equal(
    (await request(`/api/file/${file._id}`, owner, org._id, "DELETE")).status,
    200,
  );
  await running.cleanup();
  assert.equal(
    await db.collection("chunks").countDocuments({ uploadId: file._id }),
    0,
  );
  assert.equal(
    (await db.collection("organizations").findOne({ _id: org._id })).usedBytes,
    0,
  );
});
