const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { encode, decode, encodeCodec, shutdown } = require("../src/compression");
const { profileFor } = require("../src/file-profiles");
test("explicit codec registry restores exactly and rejects unknown or excessive expansion", async (t) => {
  t.after(shutdown);
  const bytes = Buffer.from(
    "Business records and numeric data.\n".repeat(3000),
  );
  for (const codec of ["none", "br", "zstd", "stp1"]) {
    const packed = await encodeCodec(bytes, codec);
    assert.deepEqual(await decode(packed, codec, bytes.length), bytes);
    await assert.rejects(decode(packed, codec, bytes.length - 1));
  }
  for (const mode of ["adaptive", "smallest", "research"]) {
    const result = await encode(bytes, { mode });
    assert.ok(result.bytes.length < bytes.length);
    assert.deepEqual(
      await decode(result.bytes, result.codec, bytes.length),
      bytes,
    );
    const random = crypto.randomBytes(32000),
      original = await encode(random, { mode });
    assert.equal(original.codec, "none");
    assert.deepEqual(original.bytes, random);
  }
  await assert.rejects(decode(Buffer.alloc(4), "invented", 4));
  // RFC 8878: an unknown-size frame advertising a 128 MiB window, one raw final byte.
  await assert.rejects(
    decode(Buffer.from("28b52ffd008809000041", "hex"), "zstd", 1),
  );
  await assert.rejects(encode(Buffer.alloc(4), { mode: "invented" }));
});
test("encoder jobs are bounded, cancelable and recover after cancellation", async (t) => {
  t.after(shutdown);
  const canceled = new AbortController();
  canceled.abort();
  await assert.rejects(
    encode(Buffer.alloc(1024), { mode: "research", signal: canceled.signal }),
    { name: "AbortError" },
  );
  const jobs = Array.from({ length: 4 }, () =>
    encode(Buffer.alloc(256000, 65), { mode: "adaptive" }),
  );
  assert.equal((await Promise.all(jobs)).length, 4);
  const result = await encode(Buffer.from("again".repeat(1000)), {
    mode: "research",
  });
  assert.deepEqual(
    await decode(result.bytes, result.codec, 5000),
    Buffer.from("again".repeat(1000)),
  );
});
test("format hints expose mismatches without trusting extensions or changing codec/security", () => {
  const png = Buffer.from("89504e470d0a1a0a", "hex");
  const hint = profileFor("ledger.csv", png, "data");
  assert.equal(hint.detected, "PNG image");
  assert.equal(hint.likelyCompressed, true);
  assert.ok(hint.warning);
  assert.equal(
    profileFor("report.docx", Buffer.from("PK\x03\x04"), "documents")
      .likelyCompressed,
    true,
  );
  assert.throws(() => profileFor("file", Buffer.alloc(0), "__proto__"));
});
test("smallest archive includes the existing maximum Brotli candidate", async (t) => {
  t.after(shutdown);
  const zlib = require("node:zlib"),
    { promisify } = require("node:util");
  const input = Buffer.from(
    "Quarterly client report: account settled, delivery confirmed, keep original records.\n".repeat(
      8192,
    ),
  );
  const maximum = await promisify(zlib.brotliCompress)(input, {
    params: {
      [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
      [zlib.constants.BROTLI_PARAM_LGWIN]: 22,
    },
  });
  const result = await encode(input, { mode: "smallest" });
  assert.ok(result.bytes.length <= maximum.length);
});
