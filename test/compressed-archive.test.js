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
test("multi-frame restore requires ordered allowlisted records and exact finality", async () => {
  const first = Buffer.from("first"),
    second = Buffer.from("second");
  const digest = (bytes) =>
    crypto.createHash("sha256").update(bytes).digest("hex");
  const json = (value) => {
    const body = Buffer.from(JSON.stringify(value)),
      length = Buffer.alloc(4);
    length.writeUInt32LE(body.length);
    return Buffer.concat([length, body]);
  };
  const frame = (bytes, index, codec = "none") =>
    Buffer.concat([
      json({
        kind: "data",
        index,
        codec,
        size: bytes.length,
        storedSize: bytes.length,
        sha256: digest(bytes),
      }),
      bytes,
    ]);
  const original = Buffer.concat([first, second]);
  const header = Buffer.concat([
    Buffer.from("STC1"),
    json({ version: 1, name: "ordered.bin", size: original.length }),
  ]);
  const end = json({
    kind: "end",
    count: 2,
    size: original.length,
    sha256: digest(original),
  });
  const valid = Buffer.concat([header, frame(first, 0), frame(second, 1), end]);
  assert.deepEqual(
    await collect(
      (await restore([valid], { maxOutputBytes: original.length })).stream,
    ),
    original,
  );
  for (const body of [
    Buffer.concat([header, frame(second, 1), frame(first, 0), end]),
    Buffer.concat([header, frame(first, 0, "unknown"), frame(second, 1), end]),
    Buffer.concat([header, frame(first, 0), frame(second, 1)]),
    Buffer.concat([valid, valid]),
    Buffer.concat([header, Buffer.from([255, 255, 255, 127])]),
    Buffer.concat([
      header,
      json({
        kind: "data",
        index: 0,
        codec: "none",
        size: 0,
        storedSize: 0,
        sha256: digest(Buffer.alloc(0)),
      }),
      end,
    ]),
  ])
    await assert.rejects(async () =>
      collect(
        (await restore([body], { maxOutputBytes: original.length })).stream,
      ),
    );
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
