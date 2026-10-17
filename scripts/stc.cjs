const fs = require("node:fs");
const fsp = require("node:fs/promises");
const crypto = require("node:crypto");
const { Readable } = require("node:stream");
const { pipeline } = require("node:stream/promises");
const { restore } = require("../src/compressed-archive");
async function main() {
  const [operation, input, output, ...extra] = process.argv.slice(2);
  const maxOutputBytes =
    extra.length === 0
      ? 10 * 1024 * 1024
      : extra.length === 2 &&
          extra[0] === "--max-bytes" &&
          /^\d{1,16}$/.test(extra[1])
        ? Number(extra[1])
        : NaN;
  if (
    operation !== "restore" ||
    !input ||
    !output ||
    !Number.isSafeInteger(maxOutputBytes) ||
    maxOutputBytes < 0 ||
    maxOutputBytes > 5 * 1024 ** 4
  )
    throw new Error(
      "Usage: node scripts/stc.cjs restore INPUT.stc OUTPUT [--max-bytes N]",
    );
  const temporary = output + ".restore-" + crypto.randomUUID() + ".tmp";
  let handle;
  try {
    const opened = await restore(fs.createReadStream(input), {
      maxOutputBytes,
    });
    handle = await fsp.open(temporary, "wx", 0o600);
    await pipeline(Readable.from(opened.stream), handle.createWriteStream());
    handle = null;
    await fsp.link(temporary, output);
    console.log(`Verified and restored ${opened.metadata.size} bytes.`);
  } finally {
    await handle?.close().catch(() => {});
    await fsp.rm(temporary, { force: true });
  }
}
if (require.main === module)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
