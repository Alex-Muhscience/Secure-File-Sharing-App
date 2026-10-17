const { test } = require("node:test");
const assert = require("node:assert/strict");
const { PaymentProviders } = require("../src/payment-providers");
const { loadConfig } = require("../src/config");
const baseEnv = {
  ENCRYPTION_KEY: "12".repeat(32),
  OTP_SECRET: "34".repeat(32),
  MONGO_URI: "mongodb://localhost/test",
  SMTP_HOST: "mail",
};
test("payment configuration defaults off and rejects live keys in test mode, invalid prices and unsafe admin grants", () => {
  assert.equal(loadConfig(baseEnv).payments.mode, "off");
  assert.equal(loadConfig({ ...baseEnv, STRIPE_SECRET_KEY: 'sk_live_example' }).payments.mode, 'off', 'Credentials can be prepared while checkout stays disabled');
  assert.throws(
    () =>
      loadConfig({
        ...baseEnv,
        BILLING_MODE: "test",
        STRIPE_SECRET_KEY: "sk_live_example",
      }),
    /Stripe/,
  );
  assert.throws(
    () =>
      loadConfig({
        ...baseEnv,
        BILLING_CATALOG: JSON.stringify({
          team: { periodDays: 30, mpesa: { currency: "usd", amountMinor: -1 } },
        }),
      }),
    /catalog/i,
  );
  assert.throws(
    () => loadConfig({ ...baseEnv, PLATFORM_ADMIN_EMAILS: "not an email" }),
    /PLATFORM_ADMIN_EMAILS/,
  );
});
test("M-Pesa and configurable crypto use provider verification and never trust a payment callback as settlement", async () => {
  let mpesaCode = "1037",
    cryptoStatus = "paid";
  const calls = [];
  const gateway = new PaymentProviders(
    {
      baseUrl: "https://files.example.com",
      payments: {
        mode: "test",
        catalog: {
          team: {
            periodDays: 30,
            mpesa: { currency: "kes", amountMinor: 10000 },
            crypto: { currency: "usd", amountMinor: 2500 },
          },
        },
        mpesa: {
          consumerKey: "fixture",
          consumerSecret: "fixture-secret",
          shortCode: "174379",
          passKey: "fixture-passkey",
        },
        crypto: { provider: "bitpay", token: "fixture-pos-token" },
      },
    },
    {
      fetch: async (url, options = {}) => {
        calls.push({ url, options });
        const data = url.includes("/oauth/")
          ? { access_token: "fixture-access" }
          : url.endsWith("/processrequest")
            ? {
                ResponseCode: "0",
                CheckoutRequestID: "checkout_1",
                MerchantRequestID: "merchant_1",
              }
            : url.endsWith("/query")
              ? { ResultCode: mpesaCode }
              : options.method === "POST"
                ? {
                    data: {
                      id: "crypto_1",
                      url: "https://test.bitpay.com/invoice?id=crypto_1",
                    },
                  }
                : {
                    data: {
                      id: "crypto_1",
                      orderId: "order_2",
                      currency: "USD",
                      price: 25,
                      status: cryptoStatus,
                      exceptionStatus: false,
                    },
                  };
        return new Response(JSON.stringify(data), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    },
  );
  const mpesa = {
    _id: "order_1",
    orgId: "workspace",
    provider: "mpesa",
    plan: "team",
    mode: "prepaid",
    currency: "kes",
    amountMinor: 10000,
    phone: "254712345678",
  };
  const started = await gateway.create(mpesa);
  assert.equal(started.externalId, "checkout_1");
  const outgoing = JSON.parse(
    calls.find((call) => call.url.endsWith("/processrequest")).options.body,
  );
  assert.equal(outgoing.Amount, 100);
  assert.equal(
    outgoing.CallBackURL,
    "https://files.example.com/api/payments/mpesa/callback",
  );
  assert.equal(
    (await gateway.verify({ ...mpesa, externalId: started.externalId })).status,
    "pending",
  );
  mpesaCode = "0";
  assert.equal(
    (await gateway.verify({ ...mpesa, externalId: started.externalId })).status,
    "paid",
  );
  const cryptoOrder = {
    _id: "order_2",
    orgId: "workspace",
    provider: "crypto",
    plan: "team",
    mode: "prepaid",
    currency: "usd",
    amountMinor: 2500,
  };
  const invoice = await gateway.create(cryptoOrder);
  assert.equal(invoice.externalId, "crypto_1");
  assert.equal(
    (await gateway.verify({ ...cryptoOrder, externalId: invoice.externalId }))
      .status,
    "pending",
    "An unconfirmed blockchain payment must not grant access",
  );
  cryptoStatus = "complete";
  assert.equal(
    (await gateway.verify({ ...cryptoOrder, externalId: invoice.externalId }))
      .status,
    "paid",
  );
  await assert.rejects(
    gateway.verify({
      ...cryptoOrder,
      externalId: invoice.externalId,
      amountMinor: 2501,
    }),
    /amount|match/i,
  );
});
