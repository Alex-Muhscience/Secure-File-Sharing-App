const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const Stripe = require("stripe");
const { MongoClient } = require("mongodb");
const { loadConfig } = require("../src/config");
const { Storage } = require("../src/storage");
const { initialize } = require("../src/database");
const { createApp } = require("../src/app");
test("billing verifies payments before atomic grants, deduplicates retries and reconciles current recurring state", async (t) => {
  const client = new MongoClient(
      process.env.TEST_MONGO_URI || "mongodb://mongo:27017",
    ),
    db = client.db(`billing_${crypto.randomBytes(6).toString("hex")}`),
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "billing-"));
  let server;
  t.after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    await db.dropDatabase();
    await client.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  await client.connect();
  await initialize(db);
  const config = {
    ...loadConfig({
      ENCRYPTION_KEY: "12".repeat(32),
      OTP_SECRET: "34".repeat(32),
      MONGO_URI: "mongodb://mongo/test",
      SMTP_HOST: "mail",
      BILLING_MODE: "test",
      STRIPE_WEBHOOK_SECRET: "whsec_fixture",
      BILLING_CATALOG: JSON.stringify({
        team: {
          periodDays: 30,
          mpesa: { currency: "kes", amountMinor: 10000 },
          stripe: {
            currency: "kes",
            amountMinor: 10000,
            recurringPriceId: "price_fixture",
            interval: "month",
          },
        },
      }),
    }),
    storage: directory,
  };
  let verified = false,
    subscriptionActive = true,
    starts = 0;
  const gateway = {
    stripe: new Stripe("sk_test_fixture"),
    settings: config.payments,
    list: () => [
      { id: "stripe", available: true, mode: "test", methods: ["recurring"] },
      { id: "mpesa", available: true, mode: "test", methods: ["prepaid"] },
      { id: "crypto", available: false, mode: "test", methods: ["prepaid"] },
    ],
    available: (provider, plan, mode) =>
      plan === "team" &&
      ((provider === "mpesa" && mode === "prepaid") ||
        (provider === "stripe" && mode === "recurring")),
    async create(order) {
      starts++;
      return {
        externalId: `${order.provider}_${starts}`,
        message: "Fixture payment pending",
      };
    },
    async verify(order) {
      return verified
        ? {
            status: "paid",
            paymentId: order.externalId,
            ...(order.mode === "recurring"
              ? { subscriptionId: "sub_fixture" }
              : {}),
          }
        : { status: "pending" };
    },
    async subscription() {
      const order = await db
        .collection("orders")
        .findOne({ provider: "stripe" });
      return {
        id: "sub_fixture",
        orgId: order.orgId,
        orderId: order._id,
        plan: "team",
        active: subscriptionActive,
        status: subscriptionActive ? "active" : "canceled",
        customerId: "cus_fixture",
        periodEnd: new Date(Date.now() + 30 * 86400000),
        invoice: null,
      };
    },
  };
  const storage = new Storage(config);
  await storage.init();
  const dependencies = {
    db,
    config,
    storage,
    paymentGateway: gateway,
    scanner: {
      async scan() {
        return { clean: true };
      },
    },
    mail: { async sendMail() {} },
  };
  const running = createApp(dependencies);
  server = running.app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`,
    token = crypto.randomBytes(32).toString("hex"),
    adminToken = crypto.randomBytes(32).toString("hex"),
    otherToken = crypto.randomBytes(32).toString("hex");
  await db.collection("sessions").insertMany(
    [
      [token, "owner@example.com"],
      [adminToken, "admin@example.com"],
      [otherToken, "other@example.com"],
    ].map(([token, email]) => ({
      _id: crypto.createHash("sha256").update(token).digest("hex"),
      email,
      expiresAt: new Date(Date.now() + 3600000),
    })),
  );
  const org = await running.pilot.createTeam(
    "owner@example.com",
    "Paying workspace",
  );
  await db
    .collection("organizations")
    .updateOne(
      { _id: org._id },
      { $push: { members: { email: "admin@example.com", role: "admin" } } },
    );
  const request = (
    url,
    credential = token,
    method = "GET",
    body,
    headers = {},
  ) =>
    fetch(base + url, {
      method,
      headers: {
        ...(credential
          ? {
              Authorization: `Bearer ${credential}`,
              "X-Organization-ID": org._id,
            }
          : {}),
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      body:
        typeof body === "string"
          ? body
          : body
            ? JSON.stringify(body)
            : undefined,
    });
  const overview = await (await request("/api/billing/overview")).json();
  const teamPrice = overview.catalog.find((plan) => plan.id === "team");
  const checkout = {
    requestId: crypto.randomUUID(),
    provider: "mpesa",
    plan: "team",
    mode: "prepaid",
    phone: "254712345678",
    acceptTerms: true,
    quoteId: teamPrice.mpesa.quotes?.prepaid,
  };
  assert.equal(
    (await request("/api/billing/checkout", adminToken, "POST", checkout))
      .status,
    403,
  );
  assert.equal(
    (
      await request("/api/billing/checkout", token, "POST", {
        ...checkout,
        acceptTerms: false,
      })
    ).status,
    400,
  );
  config.payments.catalog.team.mpesa.amountMinor = 10100;
  assert.equal(
    (await request("/api/billing/checkout", token, "POST", checkout)).status,
    409,
    "A price changed after review must not start a charge",
  );
  assert.equal(starts, 0);
  config.payments.catalog.team.mpesa.amountMinor = 10000;
  const started = await request(
    "/api/billing/checkout",
    token,
    "POST",
    checkout,
  );
  assert.equal(started.status, 201, await started.clone().text());
  const order = await started.json();
  assert.equal(
    (
      await (
        await request("/api/billing/checkout", token, "POST", checkout)
      ).json()
    ).orderId,
    order.orderId,
  );
  assert.equal(starts, 1);
  assert.equal(
    (await db.collection("organizations").findOne({ _id: org._id })).plan,
    "pilot",
  );
  await request("/api/payments/mpesa/callback", null, "POST", {
    Body: { stkCallback: { CheckoutRequestID: "mpesa_1", ResultCode: 0 } },
  });
  await running.worker.tick();
  assert.equal(
    (await db.collection("organizations").findOne({ _id: org._id })).plan,
    "pilot",
    "Callback claims must not grant entitlements",
  );
  verified = true;
  await db
    .collection("orders")
    .updateMany({ status: "pending" }, { $set: { nextAttempt: new Date(0) } });
  await Promise.all([
    running.worker.tick(),
    createApp(dependencies).worker.tick(),
  ]);
  const paid = await db.collection("organizations").findOne({ _id: org._id });
  assert.equal(paid.plan, "team");
  assert.equal(paid.paidOrders.length, 1);
  assert.ok(paid.subscription.periodEnd > new Date());
  const period = +paid.subscription.periodEnd;
  await running.worker.tick();
  assert.equal(
    +(await db.collection("organizations").findOne({ _id: org._id }))
      .subscription.periodEnd,
    period,
  );
  assert.equal(
    await db.collection("invoices").countDocuments({ orgId: org._id }),
    1,
  );
  const settledOrder = await db.collection('orders').findOne({ _id: order.orderId });
  await assert.rejects(running.worker.payments.invoice({ ...settledOrder, _id: 'different-order', orgId: 'different-workspace' }, settledOrder.externalId), /duplicate|ownership/i, 'A provider receipt cannot fund a second workspace');
  await assert.rejects(db.collection('orders').insertOne({ _id: 'external-id-replay', orgId: 'different-workspace', provider: settledOrder.provider, externalId: settledOrder.externalId, open: false }), /duplicate/i);
  assert.equal(
    (await request(`/api/billing/orders/${order.orderId}`, otherToken)).status,
    404,
  );
  const recurring = await (
    await request("/api/billing/checkout", token, "POST", {
      provider: "stripe",
      plan: "team",
      mode: "recurring",
      requestId: crypto.randomUUID(),
      acceptTerms: true,
      quoteId: teamPrice.stripe.quotes.recurring,
    })
  ).json();
  await running.worker.tick();
  assert.equal(
    (await db.collection("organizations").findOne({ _id: org._id }))
      .subscription.mode,
    "recurring",
  );
  for (const status of ['requires_review', 'unpaid', 'paused']) {
    await db.collection('organizations').updateOne({ _id: org._id }, { $set: { 'subscription.status': status } });
    assert.equal((await request('/api/billing/checkout', token, 'POST', { provider: 'stripe', plan: 'team', mode: 'recurring', requestId: crypto.randomUUID(), acceptTerms: true, quoteId: teamPrice.stripe.quotes.recurring })).status, 409, `${status} subscriptions still need provider-side resolution`);
  }
  await db.collection('organizations').updateOne({ _id: org._id }, { $set: { 'subscription.status': 'active' } });
  gateway.stripe.invoices.retrieve = async () => ({ id: 'in_older', subscription: 'sub_fixture', customer: 'cus_fixture', status: 'paid', currency: 'kes', amount_paid: 10000, livemode: false, created: Math.floor(Date.now() / 1000) });
  const olderInvoice = JSON.stringify({ id: 'evt_older_invoice', type: 'invoice.paid', livemode: false, data: { object: { id: 'in_older' } } });
  await request('/api/payments/stripe/webhook', null, 'POST', olderInvoice, { 'Stripe-Signature': gateway.stripe.webhooks.generateTestHeaderString({ payload: olderInvoice, secret: config.payments.stripe.webhookSecret }) });
  await running.worker.tick();
  assert.equal(await db.collection('invoices').countDocuments({ _id: 'stripe:in_older', orgId: org._id }), 1, 'An older paid invoice is recorded even when it is no longer the latest subscription invoice');
  assert.equal(
    (
      await request(
        "/api/payments/stripe/webhook",
        null,
        "POST",
        { id: "evt_forged" },
        { "Stripe-Signature": "forged" },
      )
    ).status,
    400,
  );
  subscriptionActive = false;
  const payload = JSON.stringify({
    id: "evt_out_of_order",
    type: "customer.subscription.updated",
    livemode: false,
    data: { object: { id: "sub_fixture" } },
  });
  const signature = gateway.stripe.webhooks.generateTestHeaderString({
    payload,
    secret: config.payments.stripe.webhookSecret,
  });
  assert.equal(
    (
      await request("/api/payments/stripe/webhook", null, "POST", payload, {
        "Stripe-Signature": signature,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await request("/api/payments/stripe/webhook", null, "POST", payload, {
        "Stripe-Signature": signature,
      })
    ).status,
    200,
  );
  await running.worker.tick();
  assert.equal(
    (await db.collection("organizations").findOne({ _id: org._id })).status,
    "suspended",
    "An older event must reconcile current provider state",
  );
  assert.equal(
    await db
      .collection("paymentEvents")
      .countDocuments({ _id: "stripe:evt_out_of_order" }),
    1,
  );
  assert.equal(
    (await (await request(`/api/billing/orders/${recurring.orderId}`)).json())
      .status,
    "paid",
  );
});
