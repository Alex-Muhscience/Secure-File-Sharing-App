const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const {
  archive,
  restore,
  archiveFromParts,
} = require("../src/compressed-archive");
const { encodeSTP } = require("../src/stc-codec");
const { shutdown } = require("../src/compression");
async function collect(source) {
  const chunks = [];
  for await (const chunk of source) chunks.push(chunk);
  return Buffer.concat(chunks);
}
test("portable archive streams exact originals, safe names, full checksums and empty finality", async (t) => {
  t.after(shutdown);
  for (const original of [
    Buffer.alloc(0),
    Buffer.from("Original document".repeat(4000)),
    crypto.randomBytes(32000),
  ]) {
    const packed = await collect(
      archive([original], {
        name: "../../private/report.txt",
        size: original.length,
        mode: "research",
      }),
    );
    const opened = await restore([packed], { maxOutputBytes: original.length });
    assert.equal(opened.metadata.name, "report.txt");
    assert.deepEqual(await collect(opened.stream), original);
    for (const broken of [
      packed.subarray(0, -1),
      Buffer.concat([packed, Buffer.from([0])]),
    ]) {
      await assert.rejects(async () => {
        const result = await restore([broken], {
          maxOutputBytes: original.length,
        });
        await collect(result.stream);
      });
    }
  }
});
test("archive reader rejects bombs, corruption and wrong ordered frames and reuses verified custom parts", async () => {
  const original = Buffer.alloc(256000, 65),
    sha256 = crypto.createHash("sha256").update(original).digest("hex");
  const packed = await collect(
    archiveFromParts(
      [
        {
          codec: "stp1",
          size: original.length,
          bytes: encodeSTP(original),
          sha256,
        },
      ],
      { name: "test.bin", size: original.length },
    ),
  );
  const opened = await restore(
    (async function* () {
      for (let i = 0; i < packed.length; i += 7)
        yield packed.subarray(i, i + 7);
    })(),
    { maxOutputBytes: original.length },
  );
  assert.deepEqual(await collect(opened.stream), original);
  await assert.rejects(restore([packed], { maxOutputBytes: 100 }));
  const damaged = Buffer.from(packed);
  damaged[Math.floor(damaged.length / 2)] ^= 128;
  await assert.rejects(async () => {
    const result = await restore([damaged], {
      maxOutputBytes: original.length,
    });
    await collect(result.stream);
  });
  await assert.rejects(
    collect(
      archiveFromParts(
        [
          {
            codec: "stp1",
            size: original.length,
            bytes: encodeSTP(original),
            sha256: "00".repeat(32),
          },
        ],
        { name: "bad", size: original.length },
      ),
    ),
  );
});
