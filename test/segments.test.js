const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { loadConfig } = require("../src/config");
const { Storage } = require("../src/storage");
test("bounded encrypted parts compress losslessly and authenticate their file, order, size and codec", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "parts-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const storage = new Storage({
    ...loadConfig({
      ENCRYPTION_KEY: "12".repeat(32),
      OTP_SECRET: "34".repeat(32),
      MONGO_URI: "mongodb://localhost/test",
      SMTP_HOST: "mail",
    }),
    storage: directory,
  });
  await storage.init();
  const uploadId = crypto.randomUUID(),
    plain = Buffer.from(
      "Client project records and repeated descriptions.\n".repeat(8000),
    );
  const part = await storage.writePart(
    { uploadId, index: 0, offset: 0 },
    plain,
    "auto",
  );
  assert.equal(part.codec, "br");
  assert.ok(part.storedSize < plain.length * 0.25);
  assert.deepEqual(await storage.decrypt(part), plain);
  for (const replacement of [
    { uploadId: crypto.randomUUID() },
    { index: 1 },
    { offset: 1 },
    { size: plain.length - 1 },
    { codec: "none" },
    { tag: "00".repeat(16) },
  ])
    await assert.rejects(storage.decrypt({ ...part, ...replacement }));
  const random = crypto.randomBytes(256 * 1024),
    randomPart = await storage.writePart(
      { uploadId, index: 1, offset: plain.length },
      random,
      "auto",
    );
  assert.equal(randomPart.codec, "none");
  assert.equal(randomPart.storedSize, random.length);
  assert.deepEqual(await storage.decrypt(randomPart), random);
  const mixed = Buffer.alloc(1024 * 1024, 65);
  crypto.randomFillSync(mixed.subarray(0, 256 * 1024));
  const mixedPart = await storage.writePart(
    { uploadId, index: 2, offset: plain.length + random.length },
    mixed,
    "auto",
  );
  assert.equal(
    mixedPart.codec,
    "br",
    "Auto mode samples more than an incompressible file prefix",
  );
  assert.ok(mixedPart.storedSize < mixed.length * 0.3);
  assert.deepEqual(await storage.decrypt(mixedPart), mixed);
  const maximum = await storage.writePart(
    { uploadId, index: 3, offset: 0 },
    plain,
    "maximum",
  );
  assert.deepEqual(await storage.decrypt(maximum), plain);
  const ciphertext = await storage.readCiphertext(part);
  await fs.writeFile(
    storage.objectPath(part.objectId),
    ciphertext.subarray(0, -1),
  );
  await assert.rejects(storage.decrypt(part));
  await assert.rejects(
    storage.writePart(
      { uploadId, index: 2, offset: 0 },
      Buffer.alloc(64 * 1024 * 1024 + 1),
      "auto",
    ),
    /size limit/,
  );
});
