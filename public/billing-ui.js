"use strict";
const billingUI = (() => {
  let review = null,
    requestId = null;
  const money = (amount, currency) =>
    new Intl.NumberFormat(undefined, {
      style: "currency",
      currency: currency.toUpperCase(),
    }).format(amount / 100);
  function redirect(url) {
    const target = new URL(url);
    if (
      target.protocol !== "https:" ||
      ![
        "checkout.stripe.com",
        "billing.stripe.com",
        "bitpay.com",
        "test.bitpay.com",
      ].includes(target.hostname) ||
      target.username ||
      target.password
    )
      throw new Error(
        "Invalid payment link. Refresh Billing before continuing.",
      );
    location.assign(target.href);
  }
  function terms() {
    if (!review) return;
    const plan = review.catalog.find(
        (item) => item.id === $("checkout-plan").value,
      ),
      price = plan[review.provider.id];
    $("checkout-terms").textContent =
      $("checkout-mode").value === "recurring"
        ? `${money(price.amountMinor, price.currency)} per ${price.interval}. Automatic renewal continues until you cancel through Stripe. Your subscription starts after payment verification.`
        : `${money(price.amountMinor, price.currency)} for ${plan.periodDays} days of ${plan.id} access. No automatic renewal. A renewal of the same prepaid plan extends its remaining access; changing plans starts a new term without prorating earlier payments.`;
    $("checkout-consent").checked = false;
  }
  function planChanged() {
    if (!review) return;
    const plan = review.catalog.find(
        (item) => item.id === $("checkout-plan").value,
      ),
      price = plan[review.provider.id];
    const modes =
      review.provider.id === "stripe"
        ? [price.prepaid && "prepaid", price.recurring && "recurring"].filter(
            Boolean,
          )
        : ["prepaid"];
    $("checkout-mode").replaceChildren(
      ...modes.map((mode) => {
        const option = node(
          "option",
          "",
          mode === "recurring"
            ? "Automatic renewal"
            : `Prepaid · ${plan.periodDays} days`,
        );
        option.value = mode;
        return option;
      }),
    );
    terms();
  }
  function open(provider, data, trigger) {
    const catalog = (data.catalog || []).filter((plan) => plan[provider.id]);
    if (!catalog.length)
      return notify("No plan is configured for this payment method.", true);
    review = { provider, catalog, revision };
    requestId = crypto.randomUUID();
    $("checkout-form").reset();
    clearError("checkout-error");
    $("checkout-plan").replaceChildren(
      ...catalog.map((plan) => {
        const option = node(
          "option",
          "",
          `${plan.id.replace(/^./, (char) => char.toUpperCase())} · ${money(plan[provider.id].amountMinor, plan[provider.id].currency)}`,
        );
        option.value = plan.id;
        return option;
      }),
    );
    $("checkout-test").hidden = provider.mode !== "test";
    $("checkout-phone-field").hidden = provider.id !== "mpesa";
    $("checkout-phone").required = provider.id === "mpesa";
    planChanged();
    showReview(false);
    openDialog($("checkout-dialog"), trigger);
  }
  function showReview(visible) {
    $("checkout-options").hidden = visible;
    $("checkout-review").hidden = !visible;
    $("checkout-consent").disabled = !visible;
    $("checkout-title").textContent = visible
      ? "Review your payment."
      : "Payment options.";
    clearError("checkout-error");
    if ($("checkout-dialog").open)
      (visible ? $("checkout-title") : $("checkout-plan")).focus({
        preventScroll: true,
      });
  }
  function next() {
    if ($("checkout-phone").required && !$("checkout-phone").reportValidity())
      return;
    terms();
    showReview(true);
  }
  function enhance(overview, payments, data) {
    if (data.subscription.periodEnd)
      overview.append(
        node(
          "p",
          "field-hint",
          `${data.subscription.mode === "recurring" ? "Current billing period ends" : "Prepaid access ends"} ${new Date(data.subscription.periodEnd).toLocaleDateString()}.`,
        ),
      );
    if (
      data.subscription.provider === "stripe" &&
      data.subscription.mode === "recurring" &&
      role() === "owner"
    ) {
      const manage = node(
        "button",
        "button button-secondary",
        "Manage Stripe subscription",
      );
      manage.type = "button";
      manage.addEventListener("click", () =>
        busy(manage, async () => {
          const started = revision,
            result = await post("/api/billing/portal", {});
          if (started === revision) redirect(result.url);
        }),
      );
      overview.append(
        manage,
        node(
          "p",
          "field-hint",
          "Change payment details, manage renewal or cancel through Stripe.",
        ),
      );
    }
    const pending = (data.orders || []).filter((order) =>
      ["creating", "pending", "review"].includes(order.status),
    );
    if (pending.length) {
      const section = node("div", "pending-payments");
      section.append(node("h3", "", "Payment in progress"));
      for (const order of pending) {
        section.append(
          node(
            "p",
            "",
            `${money(order.amountMinor, order.currency)} · ${order.provider} · ${order.status === "review" ? "Needs operator review" : "Awaiting provider verification"}`,
          ),
        );
        if (order.message)
          section.append(node("p", "field-hint", order.message));
        if (order.url && order.status === "pending" && role() === "owner") {
          const resume = node("button", "text-button", "Continue checkout");
          resume.type = "button";
          resume.addEventListener("click", () => {
            try {
              redirect(order.url);
            } catch (error) {
              notify(error.message, true);
            }
          });
          section.append(resume);
        }
      }
      const refresh = node(
        "button",
        "button button-secondary",
        "Refresh payment status",
      );
      refresh.type = "button";
      refresh.addEventListener("click", () => enterprise.load("billing"));
      section.append(refresh);
      payments.append(section);
    }
  }
  function reset() {
    review = requestId = null;
    $("checkout-dialog").close();
    $("checkout-form").reset();
  }
  document.addEventListener("DOMContentLoaded", () => {
    $("checkout-next").addEventListener("click", next);
    $("checkout-back").addEventListener("click", () => showReview(false));
    $("checkout-plan").addEventListener("change", planChanged);
    $("checkout-mode").addEventListener("change", terms);
    $("checkout-form").addEventListener("submit", (event) => {
      event.preventDefault();
      if (!review || review.revision !== revision) return;
      if ($("checkout-review").hidden) return next();
      const saved = review,
        plan = saved.catalog.find(
          (item) => item.id === $("checkout-plan").value,
        ),
        mode = $("checkout-mode").value;
      const body = {
        requestId,
        provider: saved.provider.id,
        plan: plan.id,
        mode,
        quoteId: plan[saved.provider.id].quotes[mode],
        acceptTerms: $("checkout-consent").checked,
        ...(saved.provider.id === "mpesa"
          ? { phone: $("checkout-phone").value.trim() }
          : {}),
      };
      busy(
        event.currentTarget,
        async () => {
          const result = await post("/api/billing/checkout", body);
          if (saved.revision !== revision) return;
          $("checkout-dialog").close();
          $("checkout-phone").value = "";
          if (result.url) redirect(result.url);
          else {
            notify(
              result.message ||
                "Payment requested. Access changes after provider verification.",
            );
            await enterprise.load("billing");
          }
        },
        "checkout-error",
      );
    });
  });
  return { open, enhance, reset };
})();
