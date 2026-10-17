const { chromium } = require("playwright");
const { AxeBuilder } = require("@axe-core/playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { gunzipSync } = require("node:zlib");
const base = process.env.BROWSER_APP_URL || "http://127.0.0.1:3081",
  inbox = process.env.BROWSER_MAIL_URL || "http://127.0.0.1:8025";
async function main() {
  const output = path.join(
    "test-results",
    "compression-" + (process.env.BROWSER_STORAGE || "local"),
  );
  await fs.mkdir(output, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      viewport: { width: 1366, height: 900 },
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const marker = crypto.randomBytes(6).toString("hex"),
      email = `compression-${marker}@example.com`;
    await page.goto(base);
    await page.locator("#email").fill(email);
    await page.locator("#request-form button[type=submit]").click();
    await page.locator("#verify-form").waitFor({ state: "visible" });
    const messages = await (await fetch(inbox + "/api/v1/messages")).json();
    const entry = messages.messages.find((row) =>
      row.To.some((to) => to.Address === email),
    );
    assert.ok(entry);
    const message = await (
      await fetch(inbox + "/api/v1/message/" + entry.ID)
    ).json();
    await page.locator("#code").fill(message.Text.match(/\b\d{6}\b/)[0]);
    await page.locator("#verify-form button[type=submit]").click();
    await page.locator("#workspace").waitFor({ state: "visible" });
    await page.waitForFunction(
      () => document.querySelector("#organization").options.length > 0,
    );
    async function inspect(name) {
      for (const width of [320, 375, 768, 1366]) {
        await page.setViewportSize({ width, height: 900 });
        assert.ok(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
          name + " reflow",
        );
        const overflow = await page
          .locator("#compression-dialog")
          .evaluate((el) => el.scrollWidth > el.clientWidth + 1);
        assert.equal(overflow, false, name + " dialog reflow");
      }
      await page.setViewportSize({ width: 320, height: 900 });
      await page.evaluate(
        () => (document.documentElement.style.fontSize = "200%"),
      );
      assert.equal(
        await page
          .locator("#compression-dialog")
          .evaluate((el) => el.scrollWidth > el.clientWidth + 1),
        false,
        name + " enlarged text reflow",
      );
      await page.keyboard.press("Tab");
      assert.ok(
        await page.evaluate(() =>
          Boolean(document.activeElement.closest("#compression-dialog")),
        ),
        name + " keyboard focus stays in dialog",
      );
      await page.evaluate(() => (document.documentElement.style.fontSize = ""));
      await page.setViewportSize({ width: 1366, height: 900 });
      const result = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
        .analyze();
      assert.deepEqual(
        result.violations.map((row) => ({
          id: row.id,
          nodes: row.nodes.map((n) => n.target),
        })),
        [],
        name + " accessibility",
      );
      await page.screenshot({
        path: path.join(output, name + ".png"),
        fullPage: true,
      });
    }
    await page.locator("#new-compression").click();
    await inspect("actions");
    await page.locator('[data-compression-action="download"]').click();
    for (const category of [
      "documents",
      "data",
      "developer",
      "images",
      "media",
      "archives",
    ]) {
      await page
        .locator(`input[name="compression-category"][value="${category}"]`)
        .check();
      assert.ok(
        await page
          .locator(`input[name="compression-category"][value="${category}"]`)
          .isChecked(),
      );
    }
    await page
      .locator('input[name="compression-category"][value="data"]')
      .check();
    await inspect("categories");
    await page.locator("#compression-next").click();
    const original = Buffer.from(
      "Client records: preserve every original byte.\n".repeat(2500),
    );
    await page.locator("#compression-file").setInputFiles({
      name: "records.csv",
      mimeType: "text/csv",
      buffer: original,
    });
    await inspect("file");
    await page.locator("#compression-next").click();
    await page.locator("#compression-mode").selectOption("research");
    await page.locator("#compression-back").click();
    assert.equal(
      await page
        .locator("#compression-file")
        .evaluate((el) => el.files[0].name),
      "records.csv",
    );
    await page.locator("#compression-next").click();
    assert.equal(
      await page.locator("#compression-mode").inputValue(),
      "research",
    );
    await inspect("options");
    await page.locator("#compression-next").click();
    await inspect("review");
    await page.locator("#compression-submit").click();
    await page
      .locator("#compression-result")
      .waitFor({ state: "visible", timeout: 60000 });
    const downloaded = page.waitForEvent("download");
    await page.locator("#compression-download").click();
    const archive = await downloaded;
    const archivePath = path.join(output, "records.stc");
    await archive.saveAs(archivePath);
    assert.ok((await fs.stat(archivePath)).size < original.length / 4);
    const rawDownload = page.waitForEvent("download");
    await page.locator("#compression-original").click();
    const raw = await rawDownload;
    assert.deepEqual(await fs.readFile(await raw.path()), original);
    await inspect("result");
    await page.locator("#compression-done").click();
    await page.locator("#new-compression").click();
    await page.locator('[data-compression-action="restore"]').click();
    await page.locator("#compression-file").setInputFiles(archivePath);
    await page.locator("#compression-next").click();
    await page.locator("#compression-submit").click();
    await page
      .locator("#compression-result")
      .waitFor({ state: "visible", timeout: 60000 });
    const restoredDownload = page.waitForEvent("download");
    await page.locator("#compression-original").click();
    const restored = await restoredDownload;
    assert.deepEqual(await fs.readFile(await restored.path()), original);
    await inspect("restored");
    await page.locator("#compression-done").click();
    await page.locator("#new-compression").click();
    await page.locator('[data-compression-action="send"]').click();
    await page.locator("#compression-next").click();
    const image = Buffer.from("89504e470d0a1a0a", "hex");
    await page.locator("#compression-file").setInputFiles({
      name: "signature.png",
      mimeType: "image/png",
      buffer: image,
    });
    await page.waitForFunction(() =>
      document
        .querySelector("#compression-detection")
        .textContent.includes("differs from your selected category"),
    );
    await page.locator("#compression-next").click();
    await page.locator("#compression-format").selectOption("gzip");
    await page
      .locator("#compression-recipient")
      .fill(`recipient-${marker}@example.com`);
    await inspect("send-options");
    await page.locator("#compression-next").click();
    await page.locator("#compression-submit").click();
    await page
      .locator("#compression-result")
      .waitFor({ state: "visible", timeout: 60000 });
    assert.equal(await page.locator("#compression-share").isVisible(), true);
    assert.match(
      await page.locator("#compression-share-link").inputValue(),
      /\?transfer=/,
    );
    const gzipDownload = page.waitForEvent("download");
    await page.locator("#compression-download").click();
    const gzipFile = await gzipDownload;
    assert.deepEqual(
      gunzipSync(await fs.readFile(await gzipFile.path())),
      image,
    );
    await page.waitForFunction(() =>
      document
        .querySelector("#compression-savings")
        .textContent.includes("75% target not met"),
    );
    await inspect("send-result");
    await page.locator("#compression-done").click();
    await page
      .getByRole("button", {
        name: "Compression details: signature.png",
        exact: true,
      })
      .click();
    await page.locator("#compression-result").waitFor({ state: "visible" });
    const reopenedDownload = page.waitForEvent("download");
    await page.locator("#compression-download").click();
    const reopened = await reopenedDownload;
    assert.ok(reopened.suggestedFilename().endsWith(".gz"));
    assert.deepEqual(
      gunzipSync(await fs.readFile(await reopened.path())),
      image,
    );
    await page.locator("#compression-done").click();
    await page.locator("#search").fill("records");
    assert.equal(await page.locator("#files-loading").isVisible(), false);
    assert.deepEqual(errors, []);
    console.log(
      "Compression categories, compact screens, actual compressed download/send, target misses and inspected restore passed.",
    );
  } finally {
    await browser.close();
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
