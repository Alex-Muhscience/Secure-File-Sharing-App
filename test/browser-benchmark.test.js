const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const {
  parseOptions,
  loadFixtures,
} = require("../scripts/benchmark-browser.cjs");

test("browser benchmark rejects invalid or unbounded measurement settings", () => {
  for (const args of [
    ["--repetitions", "0"],
    ["--repetitions", "21"],
    ["--repetitions", "2.5"],
    ["--repetitions", "5junk"],
    ["--modes", "auto"],
    ["--modes", "none,none"],
    ["--app-root"],
    ["--unknown", "true"],
  ])
    assert.throws(() => parseOptions(args));
  const options = parseOptions([
    "--repetitions",
    "3",
    "--modes",
    "none,research",
    "--file",
    "empty.txt",
  ]);
  assert.equal(options.repetitions, 3);
  assert.deepEqual(options.modes, ["none", "research"]);
  assert.equal(options.file, "empty.txt");
});

test("browser benchmark loads exact read-only corpus bytes and refuses symlinks and oversized files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "browser-corpus-"));
  try {
    const bytes = Buffer.from("client records\n");
    await fs.writeFile(path.join(root, "records.txt"), bytes);
    const options = parseOptions(["--input", root]);
    const [fixture] = await loadFixtures(options);
    assert.equal(fixture.name, "records.txt");
    assert.deepEqual(fixture.bytes, bytes);
    assert.equal(
      fixture.sha256,
      crypto.createHash("sha256").update(bytes).digest("hex"),
    );
    assert.deepEqual(await fs.readFile(path.join(root, "records.txt")), bytes);
    await fs.symlink(
      path.join(root, "records.txt"),
      path.join(root, "linked.txt"),
    );
    await assert.rejects(loadFixtures(options), /regular|symbolic|symlink/i);
    await fs.unlink(path.join(root, "linked.txt"));
    const oversized = await fs.open(path.join(root, "large.bin"), "w");
    await oversized.truncate(16 * 1024 * 1024 + 1);
    await oversized.close();
    await assert.rejects(loadFixtures(options), /16 MiB/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
