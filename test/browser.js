const { chromium } = require("playwright");
const { AxeBuilder } = require("@axe-core/playwright");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const base = process.env.BROWSER_APP_URL || "http://127.0.0.1:3081";
const inbox = process.env.BROWSER_MAIL_URL || "http://127.0.0.1:8025";
const output = path.join(
  "test-results",
  process.env.BROWSER_STORAGE || "local",
);
async function audit(page, name) {
  await page.screenshot({
    path: path.join(output, `${name}-audit.png`),
    fullPage: true,
  });
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  await fs.writeFile(
    path.join(output, `${name}-accessibility.json`),
    JSON.stringify(
      { violations: result.violations, incomplete: result.incomplete },
      null,
      2,
    ),
  );
  assert.deepEqual(
    result.violations.map((item) => ({
      id: item.id,
      impact: item.impact,
      nodes: item.nodes.map((node) => ({
        target: node.target,
        summary: node.failureSummary,
      })),
    })),
    [],
    `${name} accessibility`,
  );
}
async function reflow(page, name, capture = true) {
  for (const width of [320, 375, 414, 768, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.evaluate(() => document.fonts.ready);
    const overflow = await page.evaluate(() =>
      [
        ...document.querySelectorAll(
          "button, input:not(.sr-only), select, h1, h2, .file-title",
        ),
      ]
        .filter((element) => {
          const bounds = element.getBoundingClientRect();
          return (
            bounds.width &&
            bounds.height &&
            !element.closest("[hidden]") &&
            bounds.top >= 0 &&
            bounds.top < innerHeight &&
            (bounds.right > innerWidth + 1 || bounds.left < -1)
          );
        })
        .map((element) => ({
          id: element.id,
          text: element.textContent.slice(0, 100),
        })),
    );
    assert.deepEqual(overflow, [], `${name} at ${width}px`);
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      `${name} has no horizontal scroll at ${width}`,
    );
    if (capture)
      await page.screenshot({
        path: path.join(output, `${name}-${width}.png`),
        fullPage: true,
      });
  }
}
async function signIn(page, email, url = base) {
  await page.goto(url);
  await page.locator("#email").fill(email);
  await page.locator("#request-form button[type=submit]").click();
  await page.locator("#verify-form").waitFor({ state: "visible" });
  const messages = await (await fetch(`${inbox}/api/v1/messages`)).json();
  const entry = messages.messages.find((message) =>
    message.To.some((to) => to.Address === email),
  );
  assert.ok(entry);
  const message = await (
    await fetch(`${inbox}/api/v1/message/${entry.ID}`)
  ).json();
  await page.locator("#code").fill(message.Text.match(/\b\d{6}\b/)[0]);
  await page.locator("#verify-form button[type=submit]").click();
  await page.locator("#workspace").waitFor({ state: "visible" });
  await page.waitForFunction(
    () =>
      document.querySelector("#organization").options.length > 0 &&
      document.querySelector("#files-loading").hidden,
  );
}
async function sendFile(page, name, content, recipient, inspect = false) {
  await page.locator("#new-transfer").click();
  if (inspect) {
    await audit(page, "send-empty");
    await reflow(page, "send-empty");
  }
  await page
    .locator("#file")
    .setInputFiles({ name, mimeType: "text/plain", buffer: content });
  await page.locator("#send-next").click();
  await page.locator("#recipient").fill(recipient);
  if (inspect) {
    await audit(page, "send-selected");
    await reflow(page, "send-selected");
  }
  await page.locator("#send-next").click();
  await page.locator("#send-next").click();
  await page.locator("#send-submit").click();
  await page.locator("#share-result").waitFor({ state: "visible" });
  const share = await page.locator("#share-link").inputValue();
  assert.ok(share.includes("?transfer="));
  if (inspect) {
    await audit(page, "share-result");
    await page.locator("#copy").click();
    assert.equal(
      await page.evaluate(() => navigator.clipboard.readText()),
      share,
    );
    await page.screenshot({
      path: path.join(output, "share-result.png"),
      fullPage: true,
    });
  }
  await page.locator("#finish-share").click();
  return share;
}
async function main() {
  await fs.mkdir(output, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      permissions: ["clipboard-read", "clipboard-write"],
      reducedMotion: "reduce",
    });
    const sender = await context.newPage(),
      recipient = await context.newPage();
    const errors = [],
      assetErrors = [];
    for (const page of [sender, recipient]) {
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("response", (response) => {
        if (
          response.status() >= 400 &&
          /\/(styles\.css|tokens\.css|script\.js|icons\.svg|favicon\.svg|fonts\/)/.test(
            response.url(),
          )
        )
          assetErrors.push(response.url());
      });
    }
    await sender.goto(base);
    await sender.evaluate(() => document.fonts.ready);
    await audit(sender, "signin");
    await reflow(sender, "signin");
    const marker = crypto.randomBytes(6).toString("hex"),
      senderEmail = `browser-sender-${marker}@example.com`,
      recipientEmail = `browser-recipient-${marker}@example.com`;
    await signIn(sender, senderEmail);
    await audit(sender, "empty-workspace");
    await reflow(sender, "empty-workspace");
    await sender.locator("#new-transfer").click();
    assert.equal(
      await sender.evaluate(() =>
        document
          .getElementById("transfer-dialog")
          .contains(document.activeElement),
      ),
      true,
    );
    await sender.keyboard.press("Escape");
    assert.equal(await sender.locator("#transfer-dialog").isVisible(), false);
    assert.equal(
      await sender
        .locator("#new-transfer")
        .evaluate((element) => document.activeElement === element),
      true,
    );
    await sender.locator("#create-workspace").click();
    await sender.locator("#org-name").fill("Client projects");
    await sender.locator("#create-org-form button[type=submit]").click();
    await sender.locator("#team-controls").waitFor({ state: "visible" });
    await sender.locator("#member-email").fill(recipientEmail);
    await sender.locator("#member-role").selectOption("viewer");
    await sender.locator("#member-form button[type=submit]").click();
    await sender.waitForFunction(
      (address) =>
        document.querySelector("#members").textContent.includes(address),
      recipientEmail,
    );
    await sender.locator("#sandbox-plan").selectOption("team");
    await sender.locator("#sandbox-form button[type=submit]").click();
    await sender.waitForFunction(
      () => document.querySelector("#settings-plan").textContent === "Team",
    );
    await audit(sender, "workspace-settings");
    await reflow(sender, "workspace-settings");
    await sender.locator("#nav-transfers").click();
    const fileName = "Client project brief.txt",
      content = Buffer.from(
        `Project brief for verified browser transfer ${marker}.`,
      );
    const share = await sendFile(
      sender,
      fileName,
      content,
      recipientEmail,
      true,
    );
    await sendFile(
      sender,
      "Delivery notes.md",
      Buffer.from("Files and next steps for the client handoff."),
      recipientEmail,
    );
    await sendFile(
      sender,
      "Brand review feedback.txt",
      Buffer.from("Review notes for the next design milestone."),
      recipientEmail,
    );
    const hostile = "<img src=x onerror=alert(1)>.txt";
    await sendFile(
      sender,
      hostile,
      Buffer.from("A filename is always rendered as text."),
      recipientEmail,
    );
    await sender.waitForFunction(
      () =>
        [...document.querySelectorAll(".status-badge")].filter(
          (badge) => badge.textContent === "Ready to download",
        ).length === 4,
      undefined,
      { timeout: 90000 },
    );
    assert.equal(await sender.locator("#files img").count(), 0);
    await audit(sender, "transfer-workspace");
    await reflow(sender, "transfer-workspace");
    await sender.locator("#search").fill("project brief");
    await sender.locator("#files > li").first().waitFor();
    await sender.waitForFunction(
      () => document.querySelectorAll("#files > li").length === 1,
    );
    await sender.locator("#search").fill("a file that does not exist");
    await sender.locator("#empty-state").waitFor({ state: "visible" });
    await sender.locator("#empty-action").click();
    await sender.waitForFunction(
      () => document.querySelectorAll("#files > li").length === 4,
    );
    await sender.locator("[data-filter=received]").click();
    await sender.locator("#empty-state").waitFor({ state: "visible" });
    await sender.locator("[data-filter=sent]").click();
    await sender.waitForFunction(
      () => document.querySelectorAll("#files > li").length === 4,
    );
    await sender.locator("#status-filter").selectOption("expired");
    await sender.locator("#empty-state").waitFor({ state: "visible" });
    await sender.locator("#empty-action").click();
    await signIn(recipient, recipientEmail, share);
    assert.equal(await recipient.locator(".transfer.highlighted").count(), 1);
    await recipient
      .locator("#organization")
      .selectOption({ label: "Client projects" });
    await recipient.waitForFunction(
      () =>
        document.querySelector("#new-transfer").hidden &&
        document.querySelector("#nav-settings").hidden,
    );
    const downloadButton = recipient.getByRole("button", {
      name: `Download: ${fileName}`,
      exact: true,
    });
    await downloadButton.waitFor();
    const downloadEvent = recipient.waitForEvent("download");
    await downloadButton.click();
    const downloaded = await downloadEvent;
    assert.deepEqual(await fs.readFile(await downloaded.path()), content);
    await recipient.waitForFunction(
      (name) =>
        [...document.querySelectorAll('[data-action="download"]')].some(
          (button) =>
            button.getAttribute("aria-label") === `Download: ${name}` &&
            !button.disabled,
        ),
      fileName,
    );
    await downloadButton.focus();
    await recipient.waitForTimeout(5500);
    assert.equal(
      await downloadButton.evaluate(
        (element) => document.activeElement === element,
      ),
      true,
      "polling keeps keyboard focus",
    );
    await audit(recipient, "recipient-workspace");
    await reflow(recipient, "recipient-workspace");
    await sender.locator("#nav-settings").click();
    const auditEvent = sender.waitForEvent("download");
    await sender.locator("#audit-export").click();
    assert.match(
      await fs.readFile(await (await auditEvent).path(), "utf8"),
      /UPLOAD/,
    );
    await sender.locator("#nav-transfers").click();
    const remove = sender.getByRole("button", {
      name: `Remove access: ${fileName}`,
      exact: true,
    });
    await remove.click();
    await audit(sender, "remove-confirmation");
    await sender.locator("#confirm-cancel").click();
    assert.equal(
      await remove.evaluate((element) => document.activeElement === element),
      true,
    );
    await remove.click();
    await sender.locator("#confirm-action").click();
    await sender.locator("#confirm-dialog").waitFor({ state: "hidden" });
    await recipient.locator("#refresh").click();
    await downloadButton.waitFor({ state: "hidden" });
    await sender.locator("#nav-settings").click();
    await sender
      .getByRole("button", { name: `Remove ${recipientEmail}`, exact: true })
      .click();
    await sender.locator("#confirm-action").click();
    await sender.locator("#confirm-dialog").waitFor({ state: "hidden" });
    await recipient.locator("#refresh").click();
    await recipient.waitForFunction(
      () => document.querySelectorAll("#files > li").length === 0,
    );
    await recipient.locator("#account-menu").click();
    await recipient.locator("#logout").click();
    await recipient.locator("#signin").waitFor({ state: "visible" });
    await sender.locator("#account-menu").click();
    await sender.locator("#logout").click();
    await sender.locator("#signin").waitFor({ state: "visible" });
    assert.deepEqual(errors, []);
    assert.deepEqual(assetErrors, []);
    console.log(
      "PASS: real sign-in, workspaces/roles/plans, sharing/copy, scanning/download, search/filter, revocation, activity, stable focus, responsive views and WCAG axe checks",
    );
  } finally {
    await browser.close();
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
