const { PLANS } = require("./pilot");
function paymentConfig(env) {
  const mode = env.BILLING_MODE || "off";
  if (!["off", "test", "live"].includes(mode))
    throw new Error("Invalid BILLING_MODE");
  let catalog;
  try {
    catalog = JSON.parse(env.BILLING_CATALOG || "{}");
    if (!catalog || Array.isArray(catalog) || typeof catalog !== "object")
      throw new Error();
    for (const [plan, value] of Object.entries(catalog)) {
      if (
        !Object.hasOwn(PLANS, plan) ||
        !value ||
        !Number.isInteger(value.periodDays) ||
        value.periodDays < 1 ||
        value.periodDays > 366
      )
        throw new Error();
      for (const id of ["stripe", "mpesa", "crypto"]) {
        const price = value[id];
        if (!price) continue;
        if (
          !["kes", "usd", "eur", "gbp"].includes(price.currency) ||
          !Number.isSafeInteger(price.amountMinor) ||
          price.amountMinor < 1 ||
          price.amountMinor > 1000000000
        )
          throw new Error();
        if (
          id === "mpesa" &&
          (price.currency !== "kes" || price.amountMinor % 100 !== 0)
        )
          throw new Error();
        if (
          id === "stripe" &&
          ((!price.prepaidPriceId && !price.recurringPriceId) ||
            [price.prepaidPriceId, price.recurringPriceId].some(
              (id) =>
                id !== undefined &&
                (typeof id !== "string" || !/^price_[a-z\d_]+$/i.test(id)),
            ) ||
            (price.recurringPriceId &&
              !["month", "year"].includes(price.interval)))
        )
          throw new Error();
      }
    }
  } catch {
    throw new Error(
      "Invalid billing catalog: configure explicit prices, two-decimal currencies and access periods",
    );
  }
  const stripe = {
    secretKey: env.STRIPE_SECRET_KEY || "",
    webhookSecret: env.STRIPE_WEBHOOK_SECRET || "",
  };
  if (
    stripe.secretKey &&
    !new RegExp(`^(?:sk|rk)_${mode === "off" ? '(?:live|test)' : mode}_`).test(
      stripe.secretKey,
    )
  )
    throw new Error("Stripe key does not match the billing mode");
  const cryptoProvider = env.CRYPTO_PROVIDER || "";
  if (!["", "bitpay"].includes(cryptoProvider))
    throw new Error("Unsupported CRYPTO_PROVIDER adapter");
  return {
    mode,
    catalog,
    stripe,
    mpesa: {
      consumerKey: env.MPESA_CONSUMER_KEY || "",
      consumerSecret: env.MPESA_CONSUMER_SECRET || "",
      shortCode: env.MPESA_SHORT_CODE || "",
      passKey: env.MPESA_PASS_KEY || "",
    },
    crypto: { provider: cryptoProvider, token: env.BITPAY_POS_TOKEN || "" },
  };
}
module.exports = { paymentConfig };
