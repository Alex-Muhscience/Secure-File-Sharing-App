const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { sealArchive, openArchive } = require("../src/archive");
const collect = async (source) => {
  const chunks = [];
  for await (const chunk of source) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
};
test("streaming archives authenticate every frame and require a final tag without trailing data", async () => {
  const key = crypto.randomBytes(32),
    plain = crypto.randomBytes(3 * 1024 * 1024 + 13);
  const encrypted = await collect(sealArchive([plain], key));
  assert.deepEqual(await collect(openArchive([encrypted], key)), plain);
  await assert.rejects(
    collect(openArchive([encrypted], crypto.randomBytes(32))),
  );
  for (const length of [0, 5, 29, encrypted.length - 1, encrypted.length - 21])
    await assert.rejects(
      collect(openArchive([encrypted.subarray(0, length)], key)),
    );
  await assert.rejects(
    collect(openArchive([Buffer.concat([encrypted, Buffer.from([0])])], key)),
  );
  const altered = Buffer.from(encrypted);
  altered[100] ^= 1;
  await assert.rejects(collect(openArchive([altered], key)));
  const firstLength = encrypted.readUInt32BE(29) + 4,
    secondStart = 29 + firstLength,
    secondLength = encrypted.readUInt32BE(secondStart) + 4;
  const reordered = Buffer.concat([
    encrypted.subarray(0, 29),
    encrypted.subarray(secondStart, secondStart + secondLength),
    encrypted.subarray(29, secondStart),
    encrypted.subarray(secondStart + secondLength),
  ]);
  await assert.rejects(collect(openArchive([reordered], key)));
  const oversized = Buffer.from(encrypted);
  oversized.writeUInt32BE(0xffffffff, 29);
  await assert.rejects(collect(openArchive([oversized], key)), /frame/);
});
