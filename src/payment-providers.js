const Stripe = require("stripe");
class PaymentProviders {
  constructor(config, dependencies = {}) {
    this.config = config;
    this.settings = config.payments;
    this.fetch = dependencies.fetch || fetch;
    this.stripe =
      dependencies.stripe ||
      (this.settings.stripe?.secretKey
        ? new Stripe(this.settings.stripe.secretKey, {
            timeout: 15000,
            maxNetworkRetries: 1,
          })
        : null);
  }
  price(plan, provider) {
    return this.settings.catalog[plan]?.[provider];
  }
  available(provider, plan, mode = "prepaid") {
    if (this.settings.mode === "off" || !this.price(plan, provider))
      return false;
    if (provider === "stripe")
      return !!(
        this.stripe &&
        this.settings.stripe.webhookSecret &&
        this.price(plan, provider)[
          mode === "recurring" ? "recurringPriceId" : "prepaidPriceId"
        ]
      );
    if (mode !== "prepaid" || !this.config.baseUrl.startsWith("https:"))
      return false;
    if (provider === "mpesa")
      return ["consumerKey", "consumerSecret", "shortCode", "passKey"].every(
        (key) => this.settings.mpesa[key],
      );
    return (
      provider === "crypto" &&
      this.settings.crypto.provider === "bitpay" &&
      !!this.settings.crypto.token
    );
  }
  list() {
    return ["stripe", "mpesa", "crypto"].map((id) => ({
      id,
      mode: this.settings.mode === "off" ? "unconfigured" : this.settings.mode,
      available: Object.keys(this.settings.catalog).some(
        (plan) =>
          this.available(id, plan) || this.available(id, plan, "recurring"),
      ),
      methods: id === "stripe" ? ["prepaid", "recurring"] : ["prepaid"],
    }));
  }
  async json(url, options = {}) {
    const response = await this.fetch(url, {
      ...options,
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok)
      throw new Error("Payment provider is temporarily unavailable");
    const buffers = [];
    let length = 0;
    for await (const chunk of response.body) {
      length += chunk.length;
      if (length > 1024 * 1024) throw new Error("Invalid provider response");
      buffers.push(Buffer.from(chunk));
    }
    return JSON.parse(Buffer.concat(buffers).toString());
  }
  mpesaBase() {
    return this.settings.mode === "live"
      ? "https://api.safaricom.co.ke"
      : "https://sandbox.safaricom.co.ke";
  }
  async mpesaRequest(path, body) {
    const settings = this.settings.mpesa;
    const token = await this.json(
      `${this.mpesaBase()}/oauth/v1/generate?grant_type=client_credentials`,
      {
        headers: {
          Authorization: `Basic ${Buffer.from(`${settings.consumerKey}:${settings.consumerSecret}`).toString("base64")}`,
        },
      },
    );
    if (typeof token.access_token !== "string")
      throw new Error("Invalid M-Pesa authentication response");
    const timestamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
    return this.json(`${this.mpesaBase()}/mpesa/stkpush/v1/${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        BusinessShortCode: settings.shortCode,
        Password: Buffer.from(
          `${settings.shortCode}${settings.passKey}${timestamp}`,
        ).toString("base64"),
        Timestamp: timestamp,
        ...body,
      }),
    });
  }
  bitpayBase() {
    return this.settings.mode === "live"
      ? "https://bitpay.com"
      : "https://test.bitpay.com";
  }
  async create(order) {
    if (order.provider === "stripe") {
      const configured = this.price(order.plan, "stripe"),
        id =
          order.mode === "recurring"
            ? configured.recurringPriceId
            : configured.prepaidPriceId;
      const price = await this.stripe.prices.retrieve(id);
      if (
        !price.active ||
        price.unit_amount !== order.amountMinor ||
        price.currency !== order.currency ||
        price.livemode !== (this.settings.mode === "live") ||
        (order.mode === "recurring"
          ? price.recurring?.interval !== configured.interval ||
            price.recurring?.interval_count !== 1
          : !!price.recurring)
      )
        throw new Error("Stripe price does not match the configured catalog");
      const metadata = { orderId: order._id, orgId: order.orgId };
      const session = await this.stripe.checkout.sessions.create(
        {
          mode: order.mode === "recurring" ? "subscription" : "payment",
          client_reference_id: order.orgId,
          customer_email: order.owner,
          line_items: [{ price: id, quantity: 1 }],
          metadata,
          ...(order.mode === "recurring"
            ? { subscription_data: { metadata } }
            : {}),
          success_url: `${this.config.baseUrl}/?payment=${order._id}#billing`,
          cancel_url: `${this.config.baseUrl}/#billing`,
        },
        { idempotencyKey: order._id },
      );
      if (
        !session.url ||
        new URL(session.url).origin !== "https://checkout.stripe.com"
      )
        throw new Error("Invalid Stripe checkout response");
      return { externalId: session.id, url: session.url };
    }
    if (order.provider === "mpesa") {
      if (!/^254[17]\d{8}$/.test(order.phone || ""))
        throw new Error("Enter a Kenyan M-Pesa number beginning with 254");
      const data = await this.mpesaRequest("processrequest", {
        TransactionType: "CustomerPayBillOnline",
        Amount: order.amountMinor / 100,
        PartyA: order.phone,
        PartyB: this.settings.mpesa.shortCode,
        PhoneNumber: order.phone,
        CallBackURL: `${this.config.baseUrl}/api/payments/mpesa/callback`,
        AccountReference: order._id.replace(/-/g, "").slice(0, 12),
        TransactionDesc: "Workspace prepaid access",
      });
      if (
        String(data.ResponseCode) !== "0" ||
        typeof data.CheckoutRequestID !== "string"
      )
        throw new Error("M-Pesa could not start this payment");
      return {
        externalId: data.CheckoutRequestID,
        message:
          "Confirm the M-Pesa prompt on your phone. Access changes after provider verification.",
      };
    }
    const data = (
      await this.json(`${this.bitpayBase()}/invoices`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Accept-Version": "2.0.0",
        },
        body: JSON.stringify({
          token: this.settings.crypto.token,
          price: order.amountMinor / 100,
          currency: order.currency.toUpperCase(),
          orderId: order._id,
          guid: order._id,
          itemDesc: "Workspace prepaid access",
          notificationURL: `${this.config.baseUrl}/api/payments/crypto/callback`,
          redirectURL: `${this.config.baseUrl}/?payment=${order._id}#billing`,
          transactionSpeed: "low",
        }),
      })
    ).data;
    if (
      !data?.url ||
      new URL(data.url).origin !== this.bitpayBase() ||
      typeof data.id !== "string"
    )
      throw new Error("Invalid crypto checkout response");
    return { externalId: data.id, url: data.url };
  }
  async verify(order) {
    if (order.provider === "stripe") {
      const data = await this.stripe.checkout.sessions.retrieve(
        order.externalId,
      );
      if (
        data.metadata?.orderId !== order._id ||
        data.client_reference_id !== order.orgId ||
        data.livemode !== (this.settings.mode === "live") ||
        data.mode !== (order.mode === "recurring" ? "subscription" : "payment") ||
        data.amount_total !== order.amountMinor ||
        data.currency !== order.currency
      )
        throw new Error("Stripe payment does not match this order");
      if (data.status === "expired") return { status: "failed" };
      if (data.payment_status !== "paid" || data.status !== "complete")
        return { status: "pending" };
      if (order.mode === "recurring")
        return {
          status: "paid",
          subscriptionId:
            typeof data.subscription === "string"
              ? data.subscription
              : data.subscription?.id,
        };
      return {
        status: "paid",
        paymentId:
          typeof data.payment_intent === "string"
            ? data.payment_intent
            : data.payment_intent?.id || data.id,
      };
    }
    if (order.provider === "mpesa") {
      const result = await this.mpesaRequest("query", {
        CheckoutRequestID: order.externalId,
      });
      return {
        status: String(result.ResultCode) === "0" ? "paid" : "pending",
        paymentId: order.externalId,
      };
    }
    const data = (
      await this.json(
        `${this.bitpayBase()}/invoices/${encodeURIComponent(order.externalId)}?token=${encodeURIComponent(this.settings.crypto.token)}`,
        { headers: { "X-Accept-Version": "2.0.0" } },
      )
    ).data;
    if (
      !data ||
      data.id !== order.externalId ||
      data.orderId !== order._id ||
      data.currency.toLowerCase() !== order.currency ||
      Math.round(Number(data.price) * 100) !== order.amountMinor
    )
      throw new Error(
        "Crypto payment amount or identity does not match this order",
      );
    return {
      status:
        data.status === "complete" && !data.exceptionStatus
          ? "paid"
          : "pending",
      paymentId: data.id,
    };
  }
  async subscription(id) {
    const data = await this.stripe.subscriptions.retrieve(id, {
      expand: ["latest_invoice"],
    });
    const price = data.items.data[0]?.price;
    const plan = Object.keys(this.settings.catalog).find(
      (plan) => this.price(plan, "stripe")?.recurringPriceId === price?.id,
    );
    if (
      !plan ||
      data.items.data.length !== 1 ||
      data.items.data[0].quantity !== 1 ||
      data.livemode !== (this.settings.mode === "live")
    )
      throw new Error("Subscription does not match a configured plan");
    const end =
      data.items.data[0].current_period_end || data.current_period_end;
    if (!Number.isSafeInteger(end))
      throw new Error("Invalid Stripe subscription period");
    return {
      id: data.id,
      orgId: data.metadata.orgId,
      orderId: data.metadata.orderId,
      plan,
      status: data.status,
      active: ["active", "trialing"].includes(data.status),
      customerId:
        typeof data.customer === "string" ? data.customer : data.customer.id,
      periodEnd: new Date(end * 1000),
      invoice:
        typeof data.latest_invoice === "object" ? data.latest_invoice : null,
    };
  }
}
module.exports = { PaymentProviders };
