"use strict";
const enterprise = (() => {
  let platformAdmin = false,
    contextRevision = -1,
    serial = 0,
    clientSerial = 0;
  let clients = [],
    nextCursor = null,
    currentCursor = null,
    selected = null;
  const money = (amount, currency) => {
    try {
      return new Intl.NumberFormat(undefined, {
        style: "currency",
        currency: currency.toUpperCase(),
      }).format(amount / 100);
    } catch {
      return `${amount} minor units (${currency})`;
    }
  };
  const metric = (label, value, detail) => {
    const item = node("div", "dashboard-metric");
    item.append(node("dt", "", label), node("dd", "", value));
    if (detail)
      item.querySelector("dd").append(node("span", "field-hint", detail));
    return item;
  };
  function table(headers, rows, caption) {
    const wrapper = node("div", "data-table-wrap"),
      element = node("table", "data-table");
    element.append(node("caption", "sr-only", caption));
    const head = node("thead"),
      tr = node("tr");
    for (const title of headers) {
      const th = node("th", "", title);
      th.scope = "col";
      tr.append(th);
    }
    head.append(tr);
    const body = node("tbody");
    for (const values of rows) {
      const row = node("tr");
      for (const value of values) row.append(node("td", "", value));
      body.append(row);
    }
    element.append(head, body);
    wrapper.append(element);
    return wrapper;
  }
  function activity(data, platform = false) {
    const container = document.createDocumentFragment(),
      metrics = node("dl", "dashboard-metrics");
    metrics.append(
      metric(
        "Uploaded",
        bytes(data.totals.uploadBytes),
        `${data.totals.uploads.toLocaleString()} transfers`,
      ),
      metric(
        "Original downloads",
        bytes(data.totals.downloadBytes),
        `${data.totals.downloads.toLocaleString()} download requests`,
      ),
      metric(
        "Archive exports",
        bytes(data.totals.exportBytes || 0),
        `${(data.totals.exports || 0).toLocaleString()} completed streams`,
      ),
      metric(
        "Compression saved",
        bytes(data.totals.compressionSavedBytes),
        "Measured on recorded uploads",
      ),
    );
    container.append(metrics);
    const section = node("section", "settings-section activity-panel");
    section.append(
      node("h2", "", "Transfer activity"),
      node(
        "p",
        "section-description",
        `Last ${data.days} days · UTC · Download figures count authorized requests.`,
      ),
    );
    if (!data.totals.uploads && !data.totals.downloads && !data.totals.exports)
      section.append(
        node("p", "dashboard-empty", "No transfer activity in this period."),
      );
    else {
      const svg = document.createElementNS(SVG, "svg");
      svg.setAttribute("viewBox", "0 0 640 100");
      svg.setAttribute("class", "activity-chart");
      svg.setAttribute("role", "img");
      svg.setAttribute(
        "aria-label",
        "Uploaded and downloaded bytes each day. Exact values are available in the daily data table.",
      );
      const max = Math.max(
        1,
        ...data.series.map((row) =>
          Math.max(row.uploadBytes, row.downloadBytes),
        ),
      );
      const width = 640 / data.series.length;
      data.series.forEach((row, i) => {
        for (const [j, key] of ["uploadBytes", "downloadBytes"].entries()) {
          const rect = document.createElementNS(SVG, "rect"),
            h = (90 * row[key]) / max;
          rect.setAttribute("x", i * width + j * width * 0.4);
          rect.setAttribute("y", 95 - h);
          rect.setAttribute("width", Math.max(0.5, width * 0.35));
          rect.setAttribute("height", h);
          rect.setAttribute(
            "class",
            j === 0 ? "chart-upload" : "chart-download",
          );
          svg.append(rect);
        }
      });
      section.append(
        svg,
        node("p", "chart-legend", "Navy: uploads · Scarlet: downloads"),
      );
    }
    const details = node("details", "daily-data");
    details.append(node("summary", "", "View daily data"));
    let page = Math.max(0, Math.ceil(data.series.length / 7) - 1);
    const content = node("div"),
      controls = node("div", "data-pagination"),
      previous = node("button", "text-button", "Earlier days"),
      next = node("button", "text-button", "Later days"),
      label = node("span", "field-hint");
    previous.type = next.type = "button";
    const render = () => {
      const rows = data.series.slice(page * 7, page * 7 + 7);
      content.replaceChildren(
        table(
          ["Date (UTC)", "Uploaded", "Downloaded"],
          rows.map((row) => [
            row.date,
            bytes(row.uploadBytes),
            bytes(row.downloadBytes),
          ]),
          "Daily transfer volume",
        ),
      );
      previous.disabled = page === 0;
      next.disabled = (page + 1) * 7 >= data.series.length;
      label.textContent = `${rows[0]?.date || ""} – ${rows.at(-1)?.date || ""}`;
    };
    previous.addEventListener("click", () => {
      page--;
      render();
    });
    next.addEventListener("click", () => {
      page++;
      render();
    });
    render();
    controls.append(previous, label, next);
    details.append(content, controls);
    section.append(details);
    container.append(section);
    if (platform) {
      const status = node("section", "settings-section");
      status.append(node("h2", "", "Workspace health"));
      const totals = node("dl", "usage-details");
      for (const row of data.workspaces)
        totals.append(
          metric(
            `${row._id === "active" ? "Active" : "Suspended"} workspaces`,
            row.count.toLocaleString(),
            `${bytes(row.usedBytes)} stored · ${row.fileCount.toLocaleString()} files`,
          ),
        );
      status.append(totals, node("h3", "", "Gross recorded payments"));
      if (data.revenue.length)
        for (const row of data.revenue)
          status.append(node("p", "", money(row.amountMinor, row.currency)));
      else
        status.append(
          node(
            "p",
            "field-hint",
            "No live paid invoices recorded in this period. Test payments are excluded.",
          ),
        );
      container.append(status);
    }
    return container;
  }
  function billing(data) {
    const fragment = document.createDocumentFragment(),
      overview = node("section", "settings-section"),
      title = node("div", "section-heading");
    title.append(
      node(
        "h2",
        "",
        `${data.plan.replace(/^./, (char) => char.toUpperCase())} plan`,
      ),
      node(
        "span",
        "preview-tag",
        data.subscription.provider === "manual"
          ? "Managed manually"
          : data.subscription.provider,
      ),
    );
    overview.append(
      title,
      node(
        "p",
        "section-description",
        `Subscription ${data.subscription.status}. ${data.subscription.provider === "manual" ? "No automatic renewal or payment collection is configured." : "Payment status is confirmed with your provider."}`,
      ),
    );
    const usage = node("dl", "dashboard-metrics");
    usage.append(
      metric(
        "Storage",
        `${bytes(data.usedBytes)} / ${bytes(data.limits.storageBytes)}`,
      ),
      metric("People", `${data.seats} / ${data.limits.seats}`),
      metric("File allowance", data.limits.files.toLocaleString()),
    );
    overview.append(usage);
    fragment.append(overview);
    const payments = node("section", "settings-section");
    payments.append(
      node("h2", "", "Payment options"),
      node(
        "p",
        "section-description",
        "Checkout becomes available when your operator configures credentials, currency and prices.",
      ),
    );
    const options = node("div", "payment-options");
    for (const provider of data.providers) {
      const row = node("div", "payment-option"),
        button = node(
          "button",
          "button button-secondary",
          { stripe: "Stripe", mpesa: "M-Pesa", crypto: "Crypto" }[provider.id],
        );
      button.type = "button";
      button.dataset.provider = provider.id;
      button.disabled =
        !provider.available ||
        role() !== "owner" ||
        (data.subscription.mode === "recurring" &&
          !["canceled", "incomplete_expired"].includes(
            data.subscription.status,
          )) ||
        (data.orders || []).some((order) =>
          ["creating", "pending", "review"].includes(order.status),
        );
      button.addEventListener("click", () =>
        billingUI.open(provider, data, button),
      );
      row.append(
        button,
        node(
          "span",
          "field-hint",
          provider.available ? `${provider.mode} checkout` : "Not configured",
        ),
      );
      options.append(row);
    }
    payments.append(options);
    billingUI.enhance(overview, payments, data);
    fragment.append(payments);
    const invoices = node("section", "settings-section");
    invoices.append(node("h2", "", "Invoices & payments"));
    if (!data.invoices.length)
      invoices.append(node("p", "dashboard-empty", "No invoices yet."));
    else {
      let page = 0;
      const content = node("div"),
        controls = node("div", "client-pagination"),
        previous = node("button", "text-button", "Newer records"),
        next = node("button", "text-button", "Older records"),
        label = node("span", "field-hint");
      previous.type = next.type = "button";
      const render = () => {
        const rows = data.invoices.slice(page * 5, page * 5 + 5);
        content.replaceChildren(
          table(
            ["Date", "Reference", "Amount", "Status"],
            rows.map((row) => [
              new Date(row.at).toLocaleDateString(),
              row.number || row._id,
              money(row.amountMinor, row.currency),
              `${row.status}${row.test ? " (test)" : ""}`,
            ]),
            "Recent invoices",
          ),
        );
        previous.disabled = page === 0;
        next.disabled = (page + 1) * 5 >= data.invoices.length;
        label.textContent = `${page * 5 + 1}–${page * 5 + rows.length} of ${data.invoices.length} recent records`;
      };
      previous.addEventListener("click", () => {
        page--;
        render();
      });
      next.addEventListener("click", () => {
        page++;
        render();
      });
      render();
      controls.append(previous, label, next);
      controls.hidden = data.invoices.length <= 5;
      invoices.append(content, controls);
    }
    fragment.append(invoices);
    return fragment;
  }
  async function load(view) {
    const started = revision,
      task = ++serial,
      root = $(`${view}-content`);
    root.setAttribute("aria-busy", "true");
    root.replaceChildren(node("p", "field-hint", "Loading…"));
    const clientTask = view === "platform" ? loadClients() : null;
    try {
      const endpoint =
        view === "billing"
          ? "/api/billing/overview"
          : `/api/${view === "platform" ? "platform/" : ""}analytics?days=${$(`${view}-days`).value}`;
      const data = await (await api(endpoint)).json();
      if (started !== revision || task !== serial || currentView !== view)
        return;
      root.replaceChildren(
        view === "billing"
          ? billing(data)
          : activity(data, view === "platform"),
      );
      if (clientTask) await clientTask;
    } catch (error) {
      if (started !== revision || task !== serial || error.expired) return;
      const retry = node("button", "button button-secondary", "Try again");
      retry.type = "button";
      retry.addEventListener("click", () => load(view));
      root.replaceChildren(node("p", "form-error", error.message), retry);
    } finally {
      if (task === serial) root.removeAttribute("aria-busy");
    }
  }
  async function loadClients(cursor = null) {
    const started = revision,
      task = ++clientSerial;
    $("platform-clients").replaceChildren(
      node("p", "field-hint", "Loading clients…"),
    );
    $("clients-next").hidden = true;
    try {
      const params = new URLSearchParams({
        search: $("client-search").value.trim(),
        limit: "5",
      });
      if (cursor) params.set("cursor", cursor);
      const data = await (await api(`/api/platform/clients?${params}`)).json();
      if (started !== revision || task !== clientSerial) return;
      clients = data.clients;
      nextCursor = data.nextCursor;
      currentCursor = cursor;
      const list = node("ul", "client-list");
      for (const client of clients) {
        const row = node("li", "client-row"),
          copy = node("div"),
          button = node("button", "button button-secondary", "Manage");
        copy.append(
          node("strong", "", client.name),
          node("span", "field-hint", client.owner),
          node(
            "span",
            "field-hint",
            `${client.plan} · ${client.status} · ${bytes(client.usedBytes)} · ${client.seats} people`,
          ),
        );
        button.type = "button";
        button.dataset.client = client._id;
        button.setAttribute("aria-label", `Manage ${client.name}`);
        button.addEventListener("click", () => {
          selected = client;
          $("client-title").textContent = client.name;
          $("client-owner").textContent = client.owner;
          $("client-usage").textContent =
            `${bytes(client.usedBytes)} stored · ${client.fileCount} files · ${client.seats} people`;
          $("client-plan").value = client.plan;
          $("client-status").value = client.status;
          $("client-reason").value = "";
          clearError("client-error");
          $("client-plan").disabled = client.subscription.provider !== "manual";
          if (client.subscription.provider !== "manual")
            $("client-usage").textContent +=
              ". Plan changes are managed by the payment provider. Pausing workspace access does not cancel billing.";
          openDialog($("client-dialog"), button);
        });
        row.append(copy, button);
        list.append(row);
      }
      $("platform-clients").replaceChildren(
        clients.length
          ? list
          : node(
              "p",
              "dashboard-empty",
              "No client workspaces match your search.",
            ),
      );
      $("clients-next").hidden = !nextCursor;
      $("clients-first").hidden = !currentCursor;
    } catch (error) {
      if (started === revision && task === clientSerial && !error.expired)
        $("platform-clients").replaceChildren(
          node("p", "form-error", error.message),
        );
    }
  }
  function context() {
    if (contextRevision === revision) return;
    contextRevision = revision;
    serial++;
    clientSerial++;
    for (const view of ["analytics", "billing", "platform"])
      $(`${view}-content`).replaceChildren();
    $("platform-clients").replaceChildren();
    billingUI.reset();
    $("client-dialog").close();
    selected = null;
    if (token && ["analytics", "billing", "platform"].includes(currentView))
      load(currentView);
  }
  async function identity() {
    const started = revision;
    try {
      const data = await (await api("/api/me")).json();
      if (started !== revision) return;
      platformAdmin = data.platformAdmin;
      $("nav-platform").hidden = !platformAdmin;
    } catch (error) {
      if (!error.expired && started === revision) notify(error.message, true);
    }
  }
  function reset() {
    platformAdmin = false;
    $("nav-platform").hidden = true;
    context();
  }
  document.addEventListener("DOMContentLoaded", () => {
    for (const panel of ["clients", "analytics"])
      $("platform-show-" + panel).addEventListener("click", () => {
        const analytics = panel === "analytics";
        $("platform-content").hidden = !analytics;
        $("platform-period").hidden = !analytics;
        $("platform-client-panel").hidden = analytics;
        $("platform-show-clients").setAttribute(
          "aria-pressed",
          String(!analytics),
        );
        $("platform-show-analytics").setAttribute(
          "aria-pressed",
          String(analytics),
        );
      });
    for (const view of ["analytics", "platform"])
      $(`${view}-days`).addEventListener("change", () => load(view));
    $("client-search-form").addEventListener("submit", (event) => {
      event.preventDefault();
      loadClients();
    });
    $("clients-next").addEventListener("click", () => loadClients(nextCursor));
    $("clients-first").addEventListener("click", () => loadClients());
    $("client-subscription-form").addEventListener("submit", (event) => {
      event.preventDefault();
      if (!selected) return;
      const client = selected,
        body = {
          plan: $("client-plan").value,
          status: $("client-status").value,
          reason: $("client-reason").value.trim(),
          revision:
            client.subscription.provider === "manual"
              ? client.subscription.revision || 0
              : client.adminRevision || 0,
        };
      confirmAction({
        title: "Update this subscription?",
        description: `${client.name}: ${body.plan} plan, ${body.status}. ${body.status === "suspended" ? "Sending and downloading will be paused. This does not cancel provider billing." : "An operator pause will be cleared; overdue or expired billing will still prevent file access."} No payment will be collected. Reason: ${body.reason}`,
        label: "Apply change",
        trigger: event.submitter,
        action: async () => {
          await api(
            `/api/platform/clients/${encodeURIComponent(client._id)}/${client.subscription.provider === "manual" ? "subscription" : "access"}`,
            {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            },
          );
          $("client-dialog").close();
          notify("Client subscription updated.");
          await load("platform");
        },
      });
    });
  });
  return {
    load,
    context,
    identity,
    reset,
    isPlatformAdmin: () => platformAdmin,
  };
})();
