const { chromium } = require("playwright");
const { AxeBuilder } = require("@axe-core/playwright");
const express = require("express");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const email = "client@example.com",
  personal = "personal_ui_test",
  team = crypto.randomUUID();
const org = (id, name) => ({
  _id: id,
  name,
  owner: email,
  members: [{ email, role: "owner" }],
  plan: "pilot",
  status: "active",
  usedBytes: 120,
  fileCount: 1,
  limits: { storageBytes: 1024, files: 100, seats: 5 },
});
const orgs = [
  org(personal, "Personal workspace"),
  org(team, "Client collaboration workspace with a long name"),
];
const file = (orgId, name) => ({
  _id: crypto.randomUUID(),
  orgId,
  name,
  owner: email,
  recipient: "a-long-client-address-for-layout@example.com",
  size: 120,
  downloads: 2,
  status: "active",
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 86400000).toISOString(),
});
const first = file(
    personal,
    "Confidential client file — private workspace.txt",
  ),
  second = file(
    team,
    "Project proposal with a considerably longer filename for review.txt",
  );
async function main() {
  await fs.mkdir("test-results/ui", { recursive: true });
  const app = express();
  app.use((req, res, next) => {
    res.set(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    next();
  });
  app.get("/ready", (req, res) => res.json({ status: "ready" }));
  app.use(express.static(path.join(__dirname, "../public")));
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`,
    browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    async function inspectDashboard(name) {
      for (const width of [320, 375, 768, 1440]) {
        await page.setViewportSize({ width, height: width < 500 ? 812 : 1000 });
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
          true,
          `${name} fits at ${width}px`,
        );
      }
      const result = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
        .analyze();
      await fs.writeFile(
        `test-results/ui/${name}-accessibility.json`,
        JSON.stringify(result, null, 2),
      );
      await page.screenshot({
        path: `test-results/ui/${name}.png`,
        fullPage: true,
      });
      assert.deepEqual(
        result.violations.map((row) => ({
          id: row.id,
          targets: row.nodes.map((n) => n.target),
        })),
        [],
        name,
      );
    }
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    let otpCalls = 0,
      resumableMode = false,
      configuredPayments = false,
      savedUpload = null,
      holdPart = true,
      releasePart,
      failedPart = false,
      partBlockedResolve,
      uploadMode = "failure",
      releaseUpload,
      failFiles = false,
      fileRequests = 0,
      expired = false,
      holdPersonal = false,
      releasePersonal,
      personalStarted;
    const personalRequest = new Promise((resolve) => {
      personalStarted = resolve;
    });
    const partBlocked = new Promise((resolve) => {
      partBlockedResolve = resolve;
    });
    await page.route("**/api/**", async (route) => {
      const request = route.request(),
        url = new URL(request.url()),
        endpoint = url.pathname;
      const send = (value, status = 200) =>
        route.fulfill({
          status,
          contentType: "application/json",
          body: JSON.stringify(value),
        });
      if (endpoint === "/api/me") return send({ email, platformAdmin: true });
      if (
        endpoint === "/api/analytics" ||
        endpoint === "/api/platform/analytics"
      )
        return send({
          days: 7,
          timezone: "UTC",
          totals: {
            uploads: 1,
            downloads: 2,
            uploadBytes: 120,
            downloadBytes: 240,
            compressionSavedBytes: 20,
          },
          series: [
            {
              date: "2026-10-17",
              uploads: 1,
              downloads: 2,
              uploadBytes: 120,
              downloadBytes: 240,
              compressionSavedBytes: 20,
            },
          ],
          storage: { usedBytes: 120, limitBytes: 1024, fileCount: 1 },
          workspaces: [
            { _id: "active", count: 2, usedBytes: 120, fileCount: 1 },
          ],
          revenue: [],
        });
      if (endpoint === "/api/billing/overview")
        return send({
          plan: "pilot",
          limits: orgs[0].limits,
          usedBytes: 120,
          seats: 1,
          subscription: { provider: "manual", status: "active", revision: 0 },
          invoices: configuredPayments
            ? Array.from({ length: 12 }, (_, i) => ({
                _id: `fixture-${i}`,
                number: `INV-${i}`,
                at: new Date().toISOString(),
                currency: "kes",
                amountMinor: 10000,
                status: "paid",
                test: true,
              }))
            : [],
          providers: ["stripe", "mpesa", "crypto"].map((id) => ({
            id,
            available: configuredPayments && id === "stripe",
            mode: configuredPayments ? "test" : "unconfigured",
          })),
          catalog: configuredPayments
            ? [
                {
                  id: "team",
                  periodDays: 30,
                  stripe: {
                    currency: "kes",
                    amountMinor: 10000,
                    prepaid: true,
                    recurring: true,
                    interval: "month",
                    quotes: {
                      prepaid: "1".repeat(64),
                      recurring: "2".repeat(64),
                    },
                  },
                },
              ]
            : [],
        });
      if (endpoint === "/api/billing/checkout") {
        const body = request.postDataJSON();
        assert.equal(body.provider, "stripe");
        assert.equal(body.plan, "team");
        assert.equal(body.mode, "recurring");
        assert.equal(Object.hasOwn(body, "amountMinor"), false);
        assert.equal(body.acceptTerms, true);
        assert.equal(body.quoteId, "2".repeat(64));
        return send(
          {
            orderId: "fixture_payment",
            status: "pending",
            message: "Payment awaiting verification",
          },
          201,
        );
      }
      if (endpoint === "/api/platform/clients")
        return send({
          clients: orgs.map((row) => ({
            ...row,
            seats: 1,
            subscription: { provider: "manual", status: "active", revision: 0 },
          })),
          nextCursor: null,
        });
      if (endpoint === "/api/config")
        return send({
          maxFileSize: 1024,
          billingSandbox: false,
          inboxUrl: null,
          ...(resumableMode
            ? { resumable: { enabled: true, chunkSize: 4 } }
            : {}),
        });
      if (endpoint === "/api/uploads") {
        if (request.method() === "GET")
          return send({
            uploads:
              savedUpload && savedUpload.status === "uploading"
                ? [savedUpload]
                : [],
          });
        savedUpload ||= {
          ...request.postDataJSON(),
          uploadId: crypto.randomUUID(),
          chunkSize: 4,
          offset: 0,
          status: "uploading",
          expiresAt: new Date(Date.now() + 86400000).toISOString(),
        };
        return send(savedUpload, 201);
      }
      if (/^\/api\/uploads\/[^/]+\/chunks$/.test(endpoint)) {
        const offset = Number(await request.headerValue("upload-offset")),
          payload = request.postDataBuffer();
        assert.equal(
          await request.headerValue("x-chunk-sha256"),
          crypto.createHash("sha256").update(payload).digest("hex"),
        );
        assert.equal(
          payload.toString(),
          "abcdefghij".slice(offset, offset + 4),
        );
        if (!failedPart) {
          failedPart = true;
          return send({ error: "Temporary part failure" }, 503);
        }
        if (offset === 4 && holdPart) {
          await new Promise((resolve) => {
            releasePart = resolve;
            partBlockedResolve();
          });
          try {
            return await send({ error: "Paused fixture" }, 503);
          } catch {
            return;
          }
        }
        savedUpload.offset = offset + payload.length;
        return send(savedUpload);
      }
      if (/^\/api\/uploads\/[^/]+\/complete$/.test(endpoint)) {
        assert.equal(savedUpload.offset, 10);
        savedUpload.status = "complete";
        return send(
          {
            fileId: first._id,
            status: "quarantined",
            shareUrl: `${base}/?transfer=${first._id}`,
          },
          201,
        );
      }
      if (endpoint === "/api/request-otp")
        return ++otpCalls === 1
          ? send({ error: "Could not deliver a code. Please try again." }, 503)
          : send({ sessionId: crypto.randomUUID() });
      if (endpoint === "/api/verify-otp")
        return request.postDataJSON().otp === "123456"
          ? send({ token: "1".repeat(64), email })
          : send({ error: "Invalid or expired code" }, 401);
      if (endpoint === "/api/organizations")
        return send({ organizations: orgs });
      if (endpoint === "/api/usage")
        return expired
          ? send({ error: "Sign in to continue" }, 401)
          : send({
              plan: "pilot",
              limits: orgs[0].limits,
              usedBytes: 120,
              fileCount: 1,
            });
      if (endpoint === "/api/files") {
        fileRequests++;
        if (failFiles)
          return send(
            { error: "Temporary service interruption. Try again." },
            503,
          );
        const selected = await request.headerValue("x-organization-id");
        if (holdPersonal && selected === personal) {
          holdPersonal = false;
          personalStarted();
          await new Promise((resolve) => {
            releasePersonal = resolve;
          });
        }
        return send({ files: [selected === team ? second : first] });
      }
      if (endpoint === "/api/upload") {
        assert.equal(
          await request.headerValue("authorization"),
          `Bearer ${"1".repeat(64)}`,
        );
        if (uploadMode === "hold") {
          await new Promise((resolve) => {
            releaseUpload = resolve;
          });
          try {
            return await send({ error: "Cancelled fixture" }, 503);
          } catch {
            return;
          }
        }
        if (uploadMode === "failure")
          return send(
            { error: "Storage is temporarily unavailable. Please retry." },
            503,
          );
        return send(
          {
            shareUrl: `${base}/?transfer=${first._id}`,
            fileId: first._id,
            status: "quarantined",
          },
          201,
        );
      }
      if (endpoint === "/api/logout") return send({ success: true });
      return send({ error: "Unexpected test request" }, 404);
    });
    // Install before application timers are created; pause only for refresh checks.
    await page.clock.install();
    await page.goto(base + "/#billing");
    await page.locator("#email").fill(email);
    await page.locator("#request-form button[type=submit]").click();
    await page.locator("#request-error").waitFor({ state: "visible" });
    assert.equal(await page.locator("#email").inputValue(), email);
    await page.locator("#request-form button[type=submit]").click();
    await page.locator("#verify-form").waitFor({ state: "visible" });
    assert.equal(await page.locator("#local-inbox").isVisible(), false);
    await page.locator("#code").fill("999999");
    await page.locator("#verify-form button[type=submit]").click();
    await page.locator("#verify-error").waitFor({ state: "visible" });
    assert.equal(await page.locator("#code").inputValue(), "999999");
    await page.locator("#code").fill("123456");
    await page.locator("#verify-form button[type=submit]").click();
    await page
      .locator("#billing-view")
      .waitFor({ state: "visible", timeout: 2000 });
    await page.locator("#nav-transfers").click();
    await page.locator("#files li").waitFor();
    await page.locator("#nav-analytics").click();
    await page.locator("#analytics-content summary").click();
    await page.locator("#analytics-content table tbody tr").waitFor();
    assert.match(
      await page.locator("#analytics-content").textContent(),
      /240 B/,
    );
    await inspectDashboard("analytics");
    await page.locator("#analytics-days").selectOption("7");
    await page.locator("#nav-billing").click();
    await page
      .locator("#billing-content")
      .getByText("No invoices yet.", { exact: true })
      .waitFor();
    assert.equal(
      await page.locator("#billing-content button[data-provider]").count(),
      3,
    );
    assert.equal(
      await page
        .locator("#billing-content button[data-provider]:enabled")
        .count(),
      0,
    );
    await inspectDashboard("billing");
    await page.locator("#nav-platform").click();
    await page
      .locator("#platform-clients button[data-client]")
      .first()
      .waitFor();
    await inspectDashboard("platform");
    await page.locator("#platform-show-analytics").click();
    await page.locator("#platform-content").waitFor({ state: "visible" });
    await inspectDashboard("platform-analytics");
    await page.locator("#platform-show-clients").click();
    await page.locator("#platform-clients button[data-client]").first().click();
    await page.locator("#client-dialog").waitFor({ state: "visible" });
    await inspectDashboard("client-subscription");
    await page.locator("#client-dialog .dialog-close").click();
    configuredPayments = true;
    await page.locator("#nav-billing").click();
    await page.locator("#billing-content table tbody tr").first().waitFor();
    assert.equal(
      await page.locator("#billing-content table tbody tr").count(),
      5,
      "Invoice history stays compact",
    );
    await page
      .locator('#billing-content button[data-provider="stripe"]')
      .click();
    await page
      .locator("#checkout-dialog")
      .waitFor({ state: "visible", timeout: 2000 });
    await page.locator("#checkout-mode").selectOption("recurring");
    await page.locator("#checkout-next").click();
    await page.setViewportSize({ width: 375, height: 667 });
    assert.ok(
      await page
        .locator("#checkout-dialog")
        .evaluate((dialog) => dialog.scrollHeight <= dialog.clientHeight + 1),
      "Each payment screen fits a compact mobile viewport",
    );
    assert.match(
      await page.locator("#checkout-terms").textContent(),
      /automatic renewal/i,
    );
    await inspectDashboard("checkout");
    await page.locator("#checkout-consent").check();
    await page.locator("#checkout-form button[type=submit]").click();
    await page.locator("#checkout-dialog").waitFor({ state: "hidden" });
    configuredPayments = false;
    await page.locator("#nav-transfers").click();
    await page.locator("#nav-settings").click();
    assert.equal(await page.locator("#sandbox-section").isVisible(), false);
    await page.locator("#nav-transfers").click();
    await page.locator("#new-transfer").click();
    assert.equal(
      await page.locator("#recipient").isVisible(),
      false,
      "Only the file screen is visible initially",
    );
    await page.locator("#send-next").click();
    assert.equal(
      await page.locator("#file").evaluate((el) => el.validity.valid),
      false,
    );
    await page.locator("#file").setInputFiles({
      name: "too-large.txt",
      mimeType: "text/plain",
      buffer: Buffer.alloc(1025),
    });
    await page.locator("#upload-error").waitFor({ state: "visible" });
    assert.equal(await page.locator("#selected-file").isVisible(), false);
    await page.locator("#file").setInputFiles({
      name: "Client handoff.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Small test upload"),
    });
    await page.locator("#send-next").click();
    assert.equal(await page.locator("#selected-file").isVisible(), false);
    await page.locator("#recipient").fill("invalid-address");
    await page.locator("#send-next").click();
    assert.equal(await page.locator("#recipient").isVisible(), true);
    await page.locator("#recipient").fill("recipient@example.com");
    await page.locator("#send-next").click();
    await page.locator("#expiry").selectOption("72");
    await page.locator("#send-next").click();
    assert.equal(
      await page.locator("#review-recipient").textContent(),
      "recipient@example.com",
    );
    await page.locator("#send-back").click();
    assert.equal(await page.locator("#expiry").inputValue(), "72");
    await page.locator("#send-back").click();
    assert.equal(
      await page.locator("#recipient").inputValue(),
      "recipient@example.com",
    );
    await page.locator("#send-next").click();
    await page.locator("#send-next").click();
    for (const width of [375, 768, 1440]) {
      await page.setViewportSize({ width, height: width === 375 ? 667 : 900 });
      assert.equal(
        await page
          .locator("#transfer-dialog")
          .evaluate((el) => el.scrollHeight <= el.clientHeight + 2),
        true,
        `Review screen fits at ${width}px`,
      );
    }
    await page.locator("#send-submit").click();
    await page.locator("#upload-error").waitFor({ state: "visible" });
    assert.equal(
      await page.locator("#selected-name").textContent(),
      "Client handoff.txt",
    );
    assert.equal(
      await page.locator("#recipient").inputValue(),
      "recipient@example.com",
    );
    assert.equal(await page.locator("#send-submit").isEnabled(), true);
    uploadMode = "hold";
    await page.locator("#send-submit").click();
    await page.locator("#upload-feedback").waitFor({ state: "visible" });
    await page.locator("#cancel-upload").click();
    await page.waitForFunction(() =>
      document.querySelector("#upload-error").textContent.includes("cancelled"),
    );
    releaseUpload();
    uploadMode = "success";
    await page.locator("#send-submit").click();
    await page.locator("#share-result").waitFor({ state: "visible" });
    await page.evaluate(() =>
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async () => {
            throw new Error("Clipboard denied");
          },
        },
      }),
    );
    await page.locator("#copy").click();
    await page.waitForFunction(() =>
      document
        .querySelector("#status")
        .textContent.includes("copy the link manually"),
    );
    assert.equal(
      await page
        .locator("#share-link")
        .evaluate((element) => element.selectionEnd - element.selectionStart),
      (await page.locator("#share-link").inputValue()).length,
    );
    await page.keyboard.press("Escape");
    await page.locator("#transfer-dialog").waitFor({ state: "hidden" });
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
    // Finish any refresh that began before the clock stopped.
    await page.evaluate(() => refreshTask?.promise);
    failFiles = true;
    await page.locator("#refresh").click();
    await page.locator("#refresh-error").waitFor({ state: "visible" });
    assert.ok(
      (await page.locator("#files").textContent()).includes(first.name),
    );
    const retainedListing = await page.locator("#files").textContent(),
      beforeFailedRetry = fileRequests;
    await page.locator("#retry-refresh").click();
    await page.locator('#retry-refresh:not([aria-busy="true"])').waitFor();
    assert.equal(fileRequests, beforeFailedRetry + 1);
    assert.equal(
      await page.locator("#refresh-error").isVisible(),
      true,
      "A failed retry preserves the error and releases its control",
    );
    assert.equal(
      await page.locator("#files").textContent(),
      retainedListing,
      "A failed retry retains the last file listing",
    );
    // The outage can last across several background update intervals.
    const beforeBackgroundFailures = fileRequests;
    await page.clock.runFor(15000);
    await page.evaluate(() => refreshTask?.promise);
    assert.ok(fileRequests > beforeBackgroundFailures);
    assert.equal(await page.locator("#retry-refresh").isVisible(), true);
    assert.equal(
      await page.locator("#files").textContent(),
      retainedListing,
      "Background failures retain the last file listing",
    );
    const beforeRetry = fileRequests;
    failFiles = false;
    await page.locator("#retry-refresh").click();
    await page
      .locator("#refresh-error")
      .waitFor({ state: "hidden", timeout: 2000 });
    assert.equal(
      fileRequests,
      beforeRetry + 1,
      "Manual retry requests a fresh listing while background time is paused",
    );

    // Automatic recovery must also work without clicking Retry.
    failFiles = true;
    await page.locator("#refresh").click();
    await page.locator("#refresh-error").waitFor({ state: "visible" });
    const beforeBackground = fileRequests;
    failFiles = false;
    await page.clock.runFor(5000);
    await page
      .locator("#refresh-error")
      .waitFor({ state: "hidden", timeout: 2000 });
    assert.equal(
      fileRequests,
      beforeBackground + 1,
      "The scheduled refresh recovers without a manual action",
    );
    await page.clock.resume();
    holdPersonal = true;
    await page.locator("#refresh").click();
    await personalRequest;
    await page.locator("#organization").selectOption(team);
    await page.waitForFunction(
      (name) => document.querySelector("#files").textContent.includes(name),
      second.name,
    );
    releasePersonal();
    await page.waitForTimeout(200);
    assert.equal(
      (await page.locator("#files").textContent()).includes(first.name),
      false,
      "stale workspace response is discarded",
    );
    for (const width of [320, 375, 414, 768, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.evaluate(() => document.fonts.ready);
      assert.ok(
        await page.evaluate(() =>
          [
            ...document.querySelectorAll(
              "button, select, input:not(.sr-only), h1, h2, .file-title",
            ),
          ].every((element) => {
            const r = element.getBoundingClientRect();
            return (
              !r.width ||
              !r.height ||
              element.closest("[hidden]") ||
              r.top >= innerHeight ||
              (r.right <= innerWidth + 1 && r.left >= -1)
            );
          }),
        ),
        `long-content reflow at ${width}`,
      );
    }
    for (const width of [375, 768]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.evaluate(
        () => (document.documentElement.style.fontSize = "200%"),
      );
      assert.ok(
        await page.evaluate(() =>
          [
            ...document.querySelectorAll(
              "button, select, input:not(.sr-only), h1, h2",
            ),
          ].every((element) => {
            const r = element.getBoundingClientRect();
            return (
              !r.width ||
              !r.height ||
              element.closest("[hidden]") ||
              r.top >= innerHeight ||
              (r.right <= innerWidth + 1 && r.left >= -1)
            );
          }),
        ),
        "200% text reflow",
      );
      await page.screenshot({
        path: `test-results/ui/text-scale-200-${width}.png`,
        fullPage: true,
      });
      await page.evaluate(() => (document.documentElement.style.fontSize = ""));
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    const axe = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();
    await fs.writeFile(
      "test-results/ui/accessibility.json",
      JSON.stringify(axe.violations, null, 2),
    );
    assert.deepEqual(axe.violations, []);
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
    await page.evaluate(() => refreshTask?.promise);
    expired = true;
    await page.locator("#refresh").click();
    await page.locator("#signin").waitFor({ state: "visible" });
    assert.equal(await page.locator("#files").textContent(), "");
    assert.equal(await page.locator("#share-link").inputValue(), "");
    assert.equal(
      await page
        .locator("#email")
        .evaluate((element) => document.activeElement === element),
      true,
    );
    await page.clock.resume();
    expired = false;
    resumableMode = true;
    await page.reload();
    await page.locator("#email").fill(email);
    await page.locator("#request-form button[type=submit]").click();
    await page.locator("#code").fill("123456");
    await page.locator("#verify-form button[type=submit]").click();
    await page.locator("#files li").waitFor();
    await page.locator("#new-transfer").click();
    await page.locator("#file").setInputFiles({
      name: "Resumable.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("abcdefghij"),
    });
    await page.locator("#send-next").click();
    await page.locator("#recipient").fill("recipient@example.com");
    await page.locator("#send-next").click();
    await page.locator("#send-next").click();
    await page.locator("#send-submit").click();
    let blockedTimer;
    try {
      await Promise.race([
        partBlocked,
        new Promise((resolve, reject) => {
          blockedTimer = setTimeout(
            () =>
              reject(
                new Error(
                  `Upload never reached second part: ${JSON.stringify(savedUpload)}`,
                ),
              ),
            15000,
          );
        }),
      ]);
    } finally {
      clearTimeout(blockedTimer);
    }
    await page.locator("#cancel-upload").click();
    await page.waitForFunction(() =>
      document.querySelector("#upload-error").textContent.includes("paused"),
    );
    assert.equal(savedUpload.offset, 4);
    holdPart = false;
    releasePart();
    await page.locator("#send-submit").click();
    await page.locator("#share-result").waitFor({ state: "visible" });
    assert.equal(
      await page.locator("#share-link").inputValue(),
      `${base}/?transfer=${first._id}`,
    );
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
    await page.evaluate(() => refreshTask?.promise);
    expired = true;
    await page.clock.runFor(5000);
    await page.locator("#signin").waitFor({ state: "visible", timeout: 2000 });
    assert.equal(
      await page.locator("#files").textContent(),
      "",
      "Background expiry clears the previous client's file listing",
    );
    assert.equal(
      await page.locator("#share-link").inputValue(),
      "",
      "Background expiry clears the previous client's share link",
    );
    assert.deepEqual(errors, []);
    console.log(
      "PASS: sign-in errors, form preservation, server limits, upload failure/cancellation, clipboard fallback, failed/manual refresh retry, automatic refresh recovery, workspace race, 200% text, reduced motion, manual/background session expiry and accessibility",
    );
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
