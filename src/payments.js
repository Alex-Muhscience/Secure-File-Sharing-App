const crypto = require("node:crypto");
const express = require("express");
const { PaymentProviders } = require("./payment-providers");
const { PLANS } = require("./pilot");
const fail = (status, message) => Object.assign(new Error(message), { status });
const uuid = (value) =>
  typeof value === "string" &&
  /^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/.test(
    value,
  );
class Payments {
  constructor({ config, db, gateway }) {
    this.config = config;
    this.db = db;
    this.gateway = gateway || new PaymentProviders(config);
    this.orders = db.collection("orders");
    this.events = db.collection("paymentEvents");
  }
  publicRoutes(app, limit) {
    const enabled = (req, res, next) =>
      this.config.payments.mode === "off"
        ? res.status(404).json({ error: "Payments are not configured" })
        : next();
    app.post(
      "/api/payments/stripe/webhook",
      enabled,
      limit,
      express.raw({ type: "application/json", limit: "256kb" }),
      async (req, res) => {
        let event;
        try {
          event = this.gateway.stripe.webhooks.constructEvent(
            req.body,
            req.get("Stripe-Signature"),
            this.config.payments.stripe.webhookSecret,
          );
        } catch {
          return res.status(400).json({ error: "Invalid payment signature" });
        }
        if (event.livemode !== (this.config.payments.mode === "live"))
          return res.status(400).json({ error: "Payment mode mismatch" });
        if (
          typeof event.id !== "string" ||
          !/^evt_[a-z\d_]{1,180}$/i.test(event.id) ||
          typeof event.data?.object?.id !== "string"
        )
          return res.status(400).json({ error: "Invalid payment event" });
        if (
          [
            "checkout.session.completed",
            "checkout.session.async_payment_succeeded",
            "invoice.paid",
            "invoice.payment_failed",
            "customer.subscription.updated",
            "customer.subscription.deleted",
          ].includes(event.type)
        ) {
          await this.events.updateOne(
            { _id: `stripe:${event.id}` },
            {
              $setOnInsert: {
                provider: "stripe",
                type: event.type,
                objectId: event.data.object.id,
                processed: false,
                createdAt: new Date(),
                nextAttempt: new Date(),
              },
            },
            { upsert: true },
          );
        }
        res.json({ received: true });
      },
    );
    for (const provider of ["mpesa", "crypto"])
      app.post(
        `/api/payments/${provider}/callback`,
        enabled,
        limit,
        express.json({ limit: "16kb" }),
        async (req, res) => {
          const externalId =
            provider === "mpesa"
              ? req.body?.Body?.stkCallback?.CheckoutRequestID
              : req.body?.id || req.body?.data?.id;
          if (typeof externalId === "string" && externalId.length <= 200)
            await this.orders.updateOne(
              { provider, externalId, status: "pending" },
              { $set: { nextAttempt: new Date() } },
            );
          // Unsigned notifications are hints; only an authenticated provider query can grant access.
          res.json({ received: true });
        },
      );
  }
  publicOrder(order) {
    return {
      orderId: order._id,
      provider: order.provider,
      plan: order.plan,
      mode: order.mode,
      currency: order.currency,
      amountMinor: order.amountMinor,
      periodDays: order.periodDays,
      status: order.status,
      createdAt: order.createdAt,
      ...(order.url ? { url: order.url } : {}),
      ...(order.message ? { message: order.message } : {}),
    };
  }
  quote(plan, provider, mode) {
    const configured = this.config.payments.catalog[plan],
      price = configured?.[provider];
    if (!price) return null;
    return crypto
      .createHash("sha256")
      .update(
        JSON.stringify([
          plan,
          provider,
          mode,
          configured.periodDays,
          price.currency,
          price.amountMinor,
          provider === "stripe"
            ? price[
                mode === "recurring" ? "recurringPriceId" : "prepaidPriceId"
              ] || null
            : null,
          price.interval || null,
        ]),
      )
      .digest("hex");
  }
  catalog() {
    return Object.entries(this.config.payments.catalog).map(([id, plan]) => ({
      id,
      periodDays: plan.periodDays,
      ...Object.fromEntries(
        ["stripe", "mpesa", "crypto"]
          .filter((provider) => plan[provider])
          .map((provider) => [
            provider,
            {
              currency: plan[provider].currency,
              amountMinor: plan[provider].amountMinor,
              quotes: {
                prepaid: this.quote(id, provider, "prepaid"),
                ...(provider === "stripe"
                  ? { recurring: this.quote(id, provider, "recurring") }
                  : {}),
              },
              ...(provider === "stripe"
                ? {
                    prepaid: !!plan[provider].prepaidPriceId,
                    recurring: !!plan[provider].recurringPriceId,
                    interval: plan[provider].interval,
                  }
                : {}),
            },
          ]),
      ),
    }));
  }
  async checkout(req) {
    if (req.org.role !== "owner")
      throw fail(403, "Only the workspace owner can start a payment");
    const { requestId, provider, plan, mode = "prepaid", phone } = req.body;
    if (this.config.payments.mode === "off")
      throw fail(
        503,
        "Payment credentials, currency and prices have not been configured. No payment was taken.",
      );
    if (
      !uuid(requestId) ||
      typeof plan !== "string" ||
      !Object.hasOwn(PLANS, plan) ||
      !["stripe", "mpesa", "crypto"].includes(provider) ||
      !["prepaid", "recurring"].includes(mode)
    )
      throw fail(400, "Choose a configured plan and payment method");
    if (!this.gateway.available(provider, plan, mode))
      throw fail(
        503,
        "This payment method is not configured for the selected plan",
      );
    if (req.body.acceptTerms !== true)
      throw fail(400, "Review and accept the payment terms before continuing");
    if (req.body.quoteId !== this.quote(plan, provider, mode))
      throw fail(
        409,
        "The price or payment terms changed. Refresh Billing and review them again.",
      );
    if (
      provider === "mpesa" &&
      (typeof phone !== "string" || !/^254[17]\d{8}$/.test(phone))
    )
      throw fail(400, "Enter a Kenyan M-Pesa number beginning with 254");
    if (
      req.org.subscription?.mode === "recurring" &&
      !["canceled", "incomplete_expired"].includes(req.org.subscription.status)
    )
      throw fail(
        409,
        "Manage the existing recurring subscription before starting another payment",
      );
    const limits = PLANS[plan];
    if (
      req.org.usedBytes > limits.storageBytes ||
      req.org.fileCount > limits.files ||
      req.org.members.length > limits.seats
    )
      throw fail(
        409,
        "Current usage exceeds this plan. No payment was started.",
      );
    const id = crypto
      .createHash("sha256")
      .update(`${req.org._id}:${requestId}`)
      .digest("hex");
    const fingerprint = crypto
      .createHash("sha256")
      .update(JSON.stringify([provider, plan, mode, phone || null]))
      .digest("hex");
    const previous = await this.orders.findOne({ _id: id });
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        throw fail(
          409,
          "This payment request was already used with different details",
        );
      return this.publicOrder(previous);
    }
    const configured = this.config.payments.catalog[plan],
      price = configured[provider];
    const order = {
      _id: id,
      fingerprint,
      orgId: req.org._id,
      owner: req.identity,
      entitlementEpoch: req.org.entitlementEpoch || 0,
      provider,
      plan,
      mode,
      currency: price.currency,
      amountMinor: price.amountMinor,
      periodDays: configured.periodDays,
      status: "creating",
      open: true,
      createdAt: new Date(),
      test: this.config.payments.mode !== "live",
    };
    try {
      await this.orders.insertOne(order);
    } catch (error) {
      if (error.code !== 11000) throw error;
      const pending = await this.orders.findOne({
        orgId: req.org._id,
        open: true,
      });
      if (pending?._id === id) return this.publicOrder(pending);
      throw fail(
        409,
        "A payment is already pending. Review its status before starting another.",
      );
    }
    try {
      const started = await this.gateway.create({
        ...order,
        ...(phone ? { phone } : {}),
      });
      await this.orders.updateOne(
        { _id: id },
        { $set: { ...started, status: "pending", nextAttempt: new Date() } },
      );
      return this.publicOrder({ ...order, ...started, status: "pending" });
    } catch {
      // A provider timeout can follow a successful charge request. Never create a replacement automatically.
      await this.orders.updateOne(
        { _id: id },
        {
          $set: {
            status: "review",
            message:
              "The provider request needs review. Check its status before attempting another payment.",
          },
        },
      );
      throw fail(
        503,
        "The payment request could not be confirmed. Review pending payments before trying again.",
      );
    }
  }
  async invoice(order, paymentId) {
    if (typeof paymentId !== 'string' || !/^[a-z\d_-]{1,200}$/i.test(paymentId)) throw new Error('Invalid provider receipt');
    await this.db.collection("invoices").updateOne(
      { _id: `${order.provider}:${paymentId}`, orgId: order.orgId, orderId: order._id },
      {
        $setOnInsert: {
          orgId: order.orgId,
          provider: order.provider,
          orderId: order._id,
          number: paymentId,
          kind: "payment_record",
          currency: order.currency,
          amountMinor: order.amountMinor,
          status: "paid",
          test: order.test,
          at: new Date(),
        },
      },
      { upsert: true },
    );
  }
  async grant(order) {
    const orgs = this.db.collection("organizations"),
      limits = PLANS[order.plan];
    for (let attempt = 0; attempt < 5; attempt++) {
      const org = await orgs.findOne({ _id: order.orgId });
      if (!org) throw new Error("Payment workspace is unavailable");
      if (org.paidOrders?.includes(order._id)) return true;
      if ((org.entitlementEpoch || 0) !== (order.entitlementEpoch || 0)) return false;
      if (
        (org.paidOrders?.length || 0) >= 1000 ||
        org.usedBytes > limits.storageBytes ||
        org.fileCount > limits.files ||
        org.members.length > limits.seats
      )
        return false;
      const start =
        org.plan === order.plan && org.subscription?.mode === "prepaid"
          ? Math.max(Date.now(), +org.subscription.periodEnd || 0)
          : Date.now();
      const revision = (org.subscription?.revision || 0) + 1;
      const result = await orgs.updateOne(
        {
          _id: org._id,
          paidOrders: { $ne: order._id },
          entitlementEpoch: org.entitlementEpoch === undefined ? { $exists: false } : org.entitlementEpoch,
          ...(org.subscription
            ? { subscription: org.subscription }
            : { subscription: { $exists: false } }),
          adminSuspended:
            org.adminSuspended === undefined
              ? { $exists: false }
              : org.adminSuspended,
          usedBytes: { $lte: limits.storageBytes },
          fileCount: { $lte: limits.files },
          $expr: { $lte: [{ $size: "$members" }, limits.seats] },
        },
        {
          $set: {
            plan: order.plan,
            status: org.adminSuspended ? "suspended" : "active",
            subscription: {
              orderId: order._id,
              provider: order.provider,
              mode: "prepaid",
              status: "active",
              plan: order.plan,
              periodEnd: new Date(start + order.periodDays * 86400000),
              revision,
            },
          },
          $push: { paidOrders: order._id },
          $inc: { entitlementEpoch: 1 },
        },
      );
      if (result.modifiedCount) return true;
    }
    return false;
  }
  async syncSubscription(id) {
    // Acquire the workspace lock before fetching current provider state, so delayed events cannot restore old entitlements.
    const hint = await this.gateway.subscription(id),
      order = await this.orders.findOne({
        _id: hint.orderId,
        provider: "stripe",
        mode: "recurring",
        orgId: hint.orgId,
      });
    if (!order) return null;
    const lease = crypto.randomUUID(),
      orgs = this.db.collection("organizations");
    const org = await orgs.findOneAndUpdate(
      {
        _id: order.orgId,
        $or: [
          { billingLeaseUntil: { $exists: false } },
          { billingLeaseUntil: { $lte: new Date() } },
        ],
      },
      {
        $set: {
          billingLease: lease,
          billingLeaseUntil: new Date(Date.now() + 90000),
        },
      },
      { returnDocument: "after" },
    );
    if (!org) throw new Error("Subscription reconciliation is busy");
    try {
      const current = await this.gateway.subscription(id);
      if (current.orderId !== order._id || current.orgId !== org._id)
        throw new Error("Subscription ownership changed");
      const live = await orgs.findOne({ _id: org._id, billingLease: lease });
      if (!live) throw new Error("Subscription lease changed");
      const controlsCurrent = live.subscription?.provider === 'stripe' && live.subscription.externalId === id;
      const newOrder = order.status === 'pending' && (live.entitlementEpoch || 0) === (order.entitlementEpoch || 0);
      if (!controlsCurrent && !newOrder) {
        if (current.invoice?.status === 'paid') await this.stripeInvoice(current.invoice, current);
        return { ...current, entitlementApplied: false };
      }
      const limits = PLANS[current.plan],
        fits =
          live.usedBytes <= limits.storageBytes &&
          live.fileCount <= limits.files &&
          live.members.length <= limits.seats;
      const status = fits ? current.status : "requires_review",
        active = fits && current.active && +current.periodEnd > Date.now();
      const changed = await orgs.updateOne(
        {
          _id: org._id,
          billingLease: lease,
          entitlementEpoch: live.entitlementEpoch === undefined ? { $exists: false } : live.entitlementEpoch,
          plan: live.plan,
          usedBytes: live.usedBytes,
          fileCount: live.fileCount,
          members: live.members,
          adminSuspended:
            live.adminSuspended === undefined
              ? { $exists: false }
              : live.adminSuspended,
          ...(live.subscription
            ? { subscription: live.subscription }
            : { subscription: { $exists: false } }),
        },
        {
          $set: {
            plan: fits ? current.plan : live.plan,
            status: active && !live.adminSuspended ? "active" : "suspended",
            subscription: {
              orderId: order._id,
              provider: "stripe",
              mode: "recurring",
              externalId: id,
              customerId: current.customerId,
              status,
              plan: current.plan,
              periodEnd: current.periodEnd,
              revision: (live.subscription?.revision || 0) + 1,
            },
            subscriptionCheckAt: new Date(Date.now() + 60000),
          },
          ...(!controlsCurrent ? { $inc: { entitlementEpoch: 1 } } : {}),
        },
      );
      if (!changed.modifiedCount)
        throw new Error("Workspace changed during subscription reconciliation");
      if (current.invoice?.status === 'paid') await this.stripeInvoice(current.invoice, current);
      return { ...current, entitlementApplied: true };
    } finally {
      await orgs.updateOne(
        { _id: org._id, billingLease: lease },
        { $unset: { billingLease: "", billingLeaseUntil: "" } },
      );
    }
  }
  async stripeInvoice(invoice, subscription) {
    if (invoice.status !== 'paid') return;
    const customer = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id;
    const parent = invoice.subscription || invoice.parent?.subscription_details?.subscription;
    const subscriptionId = typeof parent === 'string' ? parent : parent?.id;
    if (!/^in_[a-z\d_]{1,180}$/i.test(invoice.id) || invoice.livemode !== (this.config.payments.mode === 'live') ||
        customer !== subscription.customerId || subscriptionId !== subscription.id ||
        !['kes', 'usd', 'eur', 'gbp'].includes(invoice.currency) || !Number.isSafeInteger(invoice.amount_paid) || invoice.amount_paid < 0 || !Number.isFinite(invoice.created))
      throw new Error('Invoice ownership or amount mismatch');
    await this.db.collection('invoices').updateOne({ _id: `stripe:${invoice.id}`, orgId: subscription.orgId }, { $setOnInsert: { orgId: subscription.orgId, provider: 'stripe', number: invoice.number || invoice.id, kind: 'invoice', status: 'paid', currency: invoice.currency, amountMinor: invoice.amount_paid, test: !invoice.livemode, at: new Date(invoice.created * 1000) } }, { upsert: true });
  }
  async reconcile(id) {
    const lease = crypto.randomUUID(),
      now = new Date();
    const order = await this.orders.findOneAndUpdate(
      {
        _id: id,
        status: "pending",
        $or: [
          { leaseUntil: { $exists: false } },
          { leaseUntil: { $lte: now } },
        ],
      },
      { $set: { lease, leaseUntil: new Date(+now + 120000) } },
      { returnDocument: "after" },
    );
    if (!order) return;
    try {
      const verified = await this.gateway.verify(order);
      if (verified.status === "paid") {
        let granted = true;
        if (order.mode === "recurring") {
          if (!verified.subscriptionId)
            throw new Error("Missing recurring subscription");
          granted = (await this.syncSubscription(verified.subscriptionId))?.entitlementApplied === true;
        } else {
          await this.invoice(order, verified.paymentId);
          granted = await this.grant(order);
        }
        await this.orders.updateOne(
          { _id: id, lease },
          {
            $set: {
              status: granted ? "paid" : "review",
              open: !granted,
              verifiedAt: new Date(),
              ...(verified.subscriptionId
                ? { subscriptionId: verified.subscriptionId }
                : {}),
            },
          },
        );
        await this.db
          .collection("audit")
          .updateOne(
            { _id: `payment:${id}` },
            {
              $setOnInsert: {
                action: granted ? "PAYMENT_VERIFIED" : "PAYMENT_REVIEW",
                actor: "billing",
                orgId: order.orgId,
                transferId: null,
                at: new Date(),
              },
            },
            { upsert: true },
          );
      } else if (verified.status === "failed")
        await this.orders.updateOne(
          { _id: id, lease },
          { $set: { status: "failed", open: false } },
        );
      else
        await this.orders.updateOne(
          { _id: id, lease },
          { $set: { nextAttempt: new Date(Date.now() + 30000) } },
        );
    } catch {
      await this.orders.updateOne(
        { _id: id, lease },
        {
          $set: {
            nextAttempt: new Date(Date.now() + 60000),
            message: "Waiting for payment-provider verification.",
          },
        },
      );
    } finally {
      await this.orders.updateOne(
        { _id: id, lease },
        { $unset: { lease: "", leaseUntil: "" } },
      );
    }
  }
  async tick() {
    if (this.running) return; this.running = true;
    try { await this.processPending(); } finally { this.running = false; }
  }
  async processPending() {
    if (this.config.payments.mode === "off") return;
    for await (const order of this.orders
      .find({ status: "pending", nextAttempt: { $lte: new Date() } })
      .limit(2))
      await this.reconcile(order._id);
    for (let count = 0; count < 2; count++) {
      const lease = crypto.randomUUID(),
        now = new Date();
      const event = await this.events.findOneAndUpdate(
        {
          processed: false,
          nextAttempt: { $lte: now },
          $or: [
            { leaseUntil: { $exists: false } },
            { leaseUntil: { $lte: now } },
          ],
        },
        { $set: { lease, leaseUntil: new Date(+now + 120000) } },
        { returnDocument: "after" },
      );
      if (!event) break;
      try {
        if (event.type.startsWith("checkout.")) {
          const order = await this.orders.findOne({
            provider: "stripe",
            externalId: event.objectId,
          });
          if (order) await this.reconcile(order._id);
        } else if (event.type.startsWith("customer.subscription."))
          await this.syncSubscription(event.objectId);
        else {
          const invoice = await this.gateway.stripe.invoices.retrieve(
            event.objectId,
          );
          const id =
            invoice.subscription ||
            invoice.parent?.subscription_details?.subscription;
          if (id) {
            const current = await this.syncSubscription(typeof id === 'string' ? id : id.id);
            if (current) await this.stripeInvoice(invoice, current);
          }
        }
        await this.events.updateOne(
          { _id: event._id, lease },
          {
            $set: { processed: true, processedAt: new Date() },
            $unset: { lease: "", leaseUntil: "" },
          },
        );
      } catch {
        await this.events.updateOne(
          { _id: event._id, lease },
          {
            $set: { nextAttempt: new Date(Date.now() + 60000) },
            $unset: { lease: "", leaseUntil: "" },
          },
        );
      }
    }
    for await (const org of this.db
      .collection("organizations")
      .find({
        "subscription.mode": "recurring",
        subscriptionCheckAt: { $lte: new Date() },
      })
      .limit(1)) {
      try {
        await this.syncSubscription(org.subscription.externalId);
      } catch {
        /* Keep the last confirmed state and retry; an expired period is suspended below. */
      }
    }
    await this.db
      .collection("organizations")
      .updateMany(
        {
          "subscription.provider": { $ne: "manual" },
          "subscription.periodEnd": { $lte: new Date() },
          status: "active",
        },
        { $set: { status: "suspended", "subscription.status": "expired" } },
      );
  }
}
module.exports = { Payments };
