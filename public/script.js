"use strict";
const $ = (id) => document.getElementById(id);
const SVG = "http://www.w3.org/2000/svg";
let token = null,
  identity = null,
  challenge = null,
  organization = null;
let organizations = [],
  files = [],
  usage = null,
  revision = 0,
  refreshTask = null;
let direction = "all",
  currentView = "transfers",
  loaded = false,
  activeUpload = null;
let noticeTimer,
  searchTimer,
  resendUntil = 0,
  memberSignature = "",
  pendingConfirmation = null;
let config = {
  maxFileSize: 10 * 1024 * 1024,
  billingSandbox: false,
  inboxUrl: null,
};
const sharedId = new URL(location.href).searchParams.get("transfer");
const dialogTriggers = new WeakMap();
const node = (tag, className, text) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
};
function icon(name) {
  const svg = document.createElementNS(SVG, "svg"),
    use = document.createElementNS(SVG, "use");
  svg.setAttribute("class", "icon");
  svg.setAttribute("aria-hidden", "true");
  use.setAttribute("href", `/icons.svg#${name}`);
  svg.append(use);
  return svg;
}
const bytes = (amount) => {
  if (amount < 1024) return `${amount} B`;
  if (amount < 1024 ** 2)
    return `${(amount / 1024).toLocaleString(undefined, { maximumFractionDigits: 1 })} KB`;
  if (amount < 1024 ** 3)
    return `${(amount / 1024 ** 2).toLocaleString(undefined, { maximumFractionDigits: 1 })} MB`;
  if (amount < 1024 ** 4)
    return `${(amount / 1024 ** 3).toLocaleString(undefined, { maximumFractionDigits: 1 })} GB`;
  return `${(amount / 1024 ** 4).toLocaleString(undefined, { maximumFractionDigits: 2 })} TB`;
};
const currentOrg = () => organizations.find((org) => org._id === organization);
const role = () =>
  currentOrg()?.members.find((member) => member.email === identity)?.role;
const isAdmin = () => ["owner", "admin"].includes(role());
const canSend = () =>
  !!role() && role() !== "viewer" && currentOrg()?.status === "active";
const initials = (email) =>
  email
    .split("@")[0]
    .split(/[._-]/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
function notify(message, error = false) {
  clearTimeout(noticeTimer);
  $("notification").hidden = false;
  $("notification").dataset.error = String(error);
  $("status").textContent = message;
  $("notification-icon")
    .querySelector("use")
    .setAttribute("href", `/icons.svg#${error ? "warning" : "check-circle"}`);
  if (!error)
    noticeTimer = setTimeout(() => {
      $("notification").hidden = true;
    }, 7000);
}
function formError(id, message) {
  const element = $(id);
  element.textContent = message;
  element.hidden = false;
  element.focus({ preventScroll: false });
}
function clearError(id) {
  $(id).hidden = true;
  $(id).textContent = "";
}
let authGeneration = 0;
const activeActions = new Map();
function releaseAction(root, record) {
  if (activeActions.get(root) !== record) return;
  activeActions.delete(root);
  root.removeAttribute("aria-busy");
  record.buttons.forEach((button, index) => {
    button.disabled = record.original[index];
  });
}
function resetActions() {
  for (const [root, record] of activeActions) releaseAction(root, record);
}
function advanceContext() {
  revision++;
  resetActions();
}
async function busy(root, action, errorId) {
  if (root.getAttribute("aria-busy") === "true") return;
  const hadFocus = root.matches("button") && document.activeElement === root;
  const focusFile = root.closest("[data-file-id]")?.dataset.fileId,
    focusAction = root.dataset.action,
    started = revision;
  const buttons = root.matches("button")
    ? [root]
    : [...root.querySelectorAll('button[type="submit"]')];
  const original = buttons.map((button) => button.disabled);
  const record = { buttons, original };
  activeActions.set(root, record);
  root.setAttribute("aria-busy", "true");
  buttons.forEach((button) => (button.disabled = true));
  if (errorId) clearError(errorId);
  try {
    await action();
  } catch (error) {
    if (
      started !== revision ||
      activeActions.get(root) !== record ||
      error.stale ||
      error.expired
    )
      return;
    const message =
      error.name === "AbortError"
        ? config.resumable?.enabled
          ? "Upload paused. Saved parts are kept for seven days. Resume with the same file, or discard the saved upload."
          : "Upload cancelled. Check Transfers in case it finished before cancellation."
        : error.message;
    if (
      errorId &&
      $(errorId).parentElement.closest("[hidden]") === null &&
      ($(errorId).closest("dialog")?.open ?? true)
    )
      formError(errorId, message);
    else notify(message, true);
  } finally {
    const currentAction =
      started === revision && activeActions.get(root) === record;
    if (currentAction) releaseAction(root, record);
    if (currentAction && root.id === "resend-code") resendLabel();
    if (
      hadFocus &&
      currentAction &&
      started === revision &&
      document.activeElement === document.body
    ) {
      const target = root.isConnected
        ? root
        : [...$("files").children]
            .find((item) => item.dataset.fileId === focusFile)
            ?.querySelector(`[data-action="${focusAction}"]`);
      if (target && !target.disabled && !target.closest("[hidden]"))
        target.focus({ preventScroll: true });
    }
  }
}
function expiredSession() {
  signedOut();
  notify("Your session has ended. Sign in again to continue.", true);
  $("email").focus();
  return Object.assign(new Error("Session ended"), { expired: true });
}
async function api(url, options = {}) {
  const requestToken = token,
    requestRevision = revision,
    headers = new Headers(options.headers);
  if (requestToken) headers.set("Authorization", `Bearer ${requestToken}`);
  if (organization) headers.set("X-Organization-ID", organization);
  let response;
  try {
    response = await fetch(url, { ...options, headers });
  } catch (error) {
    if (error.name === "AbortError") throw error;
    throw new Error("Could not connect. Check your connection and try again.");
  }
  if (requestRevision !== revision)
    throw Object.assign(new Error("Context changed"), { stale: true });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    if (requestRevision !== revision)
      throw Object.assign(new Error("Context changed"), { stale: true });
    if (response.status === 401 && requestToken && requestToken === token)
      throw expiredSession();
    throw new Error(
      body.error || "The request could not be completed. Please try again.",
    );
  }
  return response;
}
const post = async (url, body) =>
  (
    await api(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
  ).json();
function openDialog(dialog, trigger = document.activeElement) {
  if (dialog.open) return;
  dialogTriggers.set(dialog, trigger);
  dialog.showModal();
  const focus =
    dialog.querySelector("[autofocus]") ||
    dialog.querySelector("input:not([readonly]), select") ||
    dialog.querySelector("button");
  focus?.focus({ preventScroll: true });
}
for (const dialog of document.querySelectorAll("dialog")) {
  dialog
    .querySelector(".dialog-close")
    ?.addEventListener("click", () => dialog.close());
  dialog.addEventListener("click", (event) => {
    if (event.target !== dialog) return;
    const rect = dialog.getBoundingClientRect();
    if (
      event.clientX < rect.left ||
      event.clientX > rect.right ||
      event.clientY < rect.top ||
      event.clientY > rect.bottom
    )
      dialog.close();
  });
  dialog.addEventListener("close", () => {
    if (dialog.id === "transfer-dialog" && activeUpload) activeUpload.abort();
    if (dialog.id === "confirm-dialog") pendingConfirmation = null;
    const trigger = dialogTriggers.get(dialog);
    if (trigger?.isConnected && !trigger.closest("[hidden]"))
      trigger.focus({ preventScroll: true });
  });
}
function signedOut() {
  authGeneration++;
  advanceContext();
  activeUpload?.abort();
  token = identity = challenge = organization = null;
  organizations = [];
  files = [];
  usage = null;
  memberSignature = "";
  loaded = false;
  enterprise.reset();
  resumable.reset();
  direction = "all";
  for (const dialog of document.querySelectorAll("dialog[open]"))
    dialog.close();
  $("signin").hidden = false;
  $("workspace").hidden = true;
  $("verify-form").hidden = true;
  $("request-form").hidden = false;
  $("code").value = "";
  $("upload-form").reset();
  $("member-form").reset();
  $("search").value = "";
  $("share-link").value = "";
  $("files").replaceChildren();
  $("members").replaceChildren();
  $("organization").replaceChildren();
  $("profile-menu").hidePopover();
  $("identity").textContent = "";
  $("profile-email").textContent = "";
  $("selected-name").textContent = "";
  $("share-filename").textContent = "";
  $("share-result").hidden = true;
  $("files-loading").hidden = false;
  $("signin-title").innerText = "Your next handoff\nstarts here.";
  $("signin-description").textContent =
    "Sign in or get started with your email. No password to remember.";
  document.title = "Secure Transfer · File sharing, with control";
}
function resendLabel() {
  const seconds = Math.ceil((resendUntil - Date.now()) / 1000);
  $("resend-code").disabled = seconds > 0;
  $("resend-code").textContent =
    seconds > 0 ? `Resend in ${seconds}s` : "Resend code";
}
async function authPost(url, body, generation) {
  try {
    const result = await post(url, body);
    if (generation !== authGeneration)
      throw Object.assign(new Error("Sign-in changed"), { stale: true });
    return result;
  } catch (error) {
    if (generation !== authGeneration)
      throw Object.assign(new Error("Sign-in changed"), { stale: true });
    throw error;
  }
}
async function requestCode() {
  const generation = ++authGeneration,
    address = $("email").value.trim();
  const result = await authPost(
    "/api/request-otp",
    { email: address },
    generation,
  );
  if (address !== $("email").value.trim())
    throw Object.assign(new Error("Email changed"), { stale: true });
  challenge = result.sessionId;
  resendUntil = Date.now() + 60000;
  resendLabel();
  $("request-form").hidden = true;
  $("verify-form").hidden = false;
  $("signin-title").textContent = "Check your inbox.";
  $("signin-description").textContent =
    "One quick check, and you’re ready to share.";
  $("code-destination").textContent =
    `We sent a code to ${$("email").value.trim()}.`;
  $("code").focus();
}
$("request-form").addEventListener("submit", (event) => {
  event.preventDefault();
  busy(event.currentTarget, requestCode, "request-error");
});
$("resend-code").addEventListener("click", () =>
  busy(
    $("resend-code"),
    async () => {
      await requestCode();
      notify("A new sign-in code has been sent.");
    },
    "verify-error",
  ),
);
$("change-email").addEventListener("click", () => {
  authGeneration++;
  resetActions();
  challenge = null;
  $("verify-form").hidden = true;
  $("request-form").hidden = false;
  $("code").value = "";
  $("signin-title").textContent = "Let’s get you signed in.";
  $("signin-description").textContent =
    "Use the email you want to send and receive files with.";
  clearError("request-error");
  clearError("verify-error");
  $("email").focus();
});
$("verify-form").addEventListener("submit", (event) => {
  event.preventDefault();
  busy(
    event.currentTarget,
    async () => {
      const generation = ++authGeneration;
      const result = await authPost(
        "/api/verify-otp",
        { sessionId: challenge, otp: $("code").value.trim() },
        generation,
      );
      advanceContext();
      token = result.token;
      identity = result.email;
      challenge = null;
      $("code").value = "";
      $("verify-form").hidden = true;
      $("signin").hidden = true;
      $("workspace").hidden = false;
      $("notification").hidden = true;
      $("identity").textContent = identity;
      $("identity").title = identity;
      $("avatar").replaceChildren(icon("user"));
      $("profile-email").textContent = identity;
      $("files-loading").hidden = false;
      $("empty-state").hidden = true;
      $("status-filter").value = "all";
      $("search").value = "";
      navigate(
        location.hash === "#workspace" ? "settings" : "transfers",
        false,
        false,
      );
      await refresh();
      await enterprise.identity();
      navigate(
        location.hash === "#workspace" ? "settings" : location.hash.slice(1),
        false,
      );
    },
    "verify-error",
  );
});
function navigate(view, writeHistory = true, focus = true) {
  currentView =
    (view === "platform" && enterprise.isPlatformAdmin()) ||
    (["settings", "analytics", "billing"].includes(view) && isAdmin())
      ? view
      : "transfers";
  $("team-controls").hidden = currentView !== "settings";
  $("transfers-view").hidden = currentView !== "transfers";
  const labels = {
    transfers: "Transfers",
    settings: "Workspace settings",
    analytics: "Analytics",
    billing: "Billing",
    platform: "Platform",
  };
  $("page-location").textContent = labels[currentView];
  for (const name of ["analytics", "billing", "platform"])
    $(`${name}-view`).hidden = currentView !== name;
  for (const [id, selected] of [
    ["nav-transfers", currentView === "transfers"],
    ["nav-settings", currentView === "settings"],
    ["nav-analytics", currentView === "analytics"],
    ["nav-billing", currentView === "billing"],
    ["nav-platform", currentView === "platform"],
  ]) {
    $(id).classList.toggle("is-active", selected);
    if (selected) $(id).setAttribute("aria-current", "page");
    else $(id).removeAttribute("aria-current");
  }
  document.title = `${labels[currentView]} · Secure Transfer`;
  const hash = currentView === "settings" ? "#workspace" : `#${currentView}`;
  if (writeHistory && location.hash !== hash) history.pushState(null, "", hash);
  if (focus)
    $(`${currentView === "settings" ? "settings" : currentView}-title`).focus({
      preventScroll: true,
    });
  if (["analytics", "billing", "platform"].includes(currentView))
    enterprise.load(currentView);
}
$("nav-transfers").addEventListener("click", () => navigate("transfers"));
$("nav-settings").addEventListener("click", () => navigate("settings"));
for (const view of ["analytics", "billing", "platform"])
  $(`nav-${view}`).addEventListener("click", () => navigate(view));
window.addEventListener("popstate", () => {
  if (token)
    navigate(
      location.hash === "#workspace" ? "settings" : location.hash.slice(1),
      false,
    );
});
async function loadOrganizations() {
  const started = revision,
    { organizations: incoming } = await (
      await api("/api/organizations")
    ).json();
  if (started !== revision || !token) return false;
  organizations = incoming;
  if (!organizations.some((org) => org._id === organization)) {
    organization =
      organizations.find(
        (org) => org._id.startsWith("personal_") && org.owner === identity,
      )?._id || organizations[0]?._id;
    advanceContext();
  }
  const optionSignature = JSON.stringify(
    organizations.map((org) => [org._id, org.name]),
  );
  if ($("organization").dataset.signature !== optionSignature) {
    $("organization").replaceChildren(
      ...organizations.map((org) => {
        const option = node("option", "", org.name);
        option.value = org._id;
        return option;
      }),
    );
    $("organization").dataset.signature = optionSignature;
  }
  $("organization").value = organization;
  renderContext();
  return true;
}
function renderContext() {
  const org = currentOrg();
  if (!org) return;
  $("workspace-name").textContent = org.name;
  $("workspace-name").title = org.name;
  $("account-role").textContent =
    `${role() === "admin" ? "Administrator" : role()?.replace(/^./, (letter) => letter.toUpperCase())} access`;
  $("plan-label").textContent =
    `${org.plan.replace(/^./, (char) => char.toUpperCase())} plan`;
  $("nav-settings").hidden = !isAdmin();
  $("nav-analytics").hidden = $("nav-billing").hidden = !isAdmin();
  $("new-transfer").hidden = !canSend();
  $("workspace-notice").hidden = canSend();
  $("workspace-notice").textContent =
    org.status !== "active"
      ? "This workspace is paused. An owner can review its plan in Workspace settings."
      : "You have viewer access. You can download files shared with you; sending files requires member access.";
  if (["settings", "analytics", "billing"].includes(currentView) && !isAdmin())
    navigate("transfers", false);
  enterprise.context();
  resumable.context();
  $("sandbox-section").hidden = !(role() === "owner" && config.billingSandbox);
  if ($("sandbox-plan").dataset.context !== `${org._id}:${org.plan}`) {
    $("sandbox-plan").value = org.plan;
    $("sandbox-plan").dataset.context = `${org._id}:${org.plan}`;
  }
  $("member-role").querySelector('option[value="admin"]').hidden =
    role() !== "owner";
  if (role() !== "owner" && $("member-role").value === "admin")
    $("member-role").value = "member";
  $("seat-summary").textContent =
    `${org.members.length} of ${org.limits.seats} people`;
  const signature = JSON.stringify([org._id, org.members, role()]);
  if (signature !== memberSignature) {
    $("members").replaceChildren(
      ...org.members.map((member) => {
        const row = node("li", "member-row"),
          avatar = node("span", "avatar", initials(member.email));
        avatar.setAttribute("aria-hidden", "true");
        const copy = node("div", "member-copy");
        copy.append(
          node("span", "", member.email),
          node(
            "span",
            "member-role",
            `${member.role === "admin" ? "Administrator" : member.role}${member.email === identity ? " · you" : ""}`,
          ),
        );
        row.append(avatar, copy);
        if (role() === "owner" && member.role !== "owner") {
          const remove = node("button", "icon-button");
          remove.type = "button";
          remove.setAttribute("aria-label", `Remove ${member.email}`);
          remove.title = `Remove ${member.email}`;
          remove.append(icon("close"));
          remove.addEventListener("click", () =>
            confirmAction({
              title: "Remove this person’s access?",
              description: `${member.email} will lose membership and existing recipient access to this workspace’s files. This cannot restore their old sharing grants later.`,
              label: "Remove member",
              trigger: remove,
              action: async () => {
                await api(
                  `/api/organizations/${organization}/members/${encodeURIComponent(member.email)}`,
                  { method: "DELETE" },
                );
                await loadOrganizations();
                await refresh();
                notify("Member access removed.");
              },
            }),
          );
          row.append(remove);
        }
        return row;
      }),
    );
    memberSignature = signature;
  }
}
function renderUsage() {
  if (!usage) return;
  const percent = Math.min(
    100,
    (usage.usedBytes / usage.limits.storageBytes) * 100,
  );
  $("storage-percent").textContent = `${Math.round(percent)}%`;
  $("storage-progress").value = percent;
  $("storage-progress").setAttribute(
    "aria-valuetext",
    `${bytes(usage.usedBytes)} of ${bytes(usage.limits.storageBytes)}`,
  );
  $("usage-summary").textContent =
    `${bytes(usage.usedBytes)} of ${bytes(usage.limits.storageBytes)} used`;
  $("quota-files").textContent =
    `${usage.fileCount} of ${usage.limits.files} files stored`;
  $("settings-storage").textContent =
    `${bytes(usage.usedBytes)} / ${bytes(usage.limits.storageBytes)}`;
  $("settings-files").textContent =
    `${usage.fileCount} / ${usage.limits.files}`;
  $("settings-plan").textContent = usage.plan.replace(/^./, (char) =>
    char.toUpperCase(),
  );
  $("settings-usage").textContent =
    `Storage and file limits are shared by everyone in ${currentOrg()?.name || "this workspace"}.`;
}
function fileState(file) {
  if (file.status === "deleted")
    return { key: "removed", label: "Removed", icon: "block" };
  if (file.status === "blocked" || file.scanResult === "infected")
    return { key: "blocked", label: "Blocked", icon: "shield" };
  if (file.status === "deleting")
    return { key: "removed", label: "Removing", icon: "clock" };
  if (+new Date(file.expiresAt) <= Date.now())
    return { key: "expired", label: "Expired", icon: "clock" };
  if (file.status === "active")
    return { key: "ready", label: "Ready to download", icon: "check-circle" };
  if (file.scanResult === "size_limit")
    return {
      key: "checking",
      label: "Inspection limit reached",
      icon: "clock",
    };
  return { key: "checking", label: "Checking file", icon: "clock" };
}
const canRemove = (file) =>
  file.orgId === organization &&
  role() !== "viewer" &&
  (file.owner === identity || isAdmin()) &&
  ["active", "quarantined", "blocked"].includes(file.status);
function rowAction(file, name, label, action, className = "") {
  const button = node("button", `row-action ${className}`);
  button.type = "button";
  button.dataset.action = name;
  button.setAttribute("aria-label", `${label}: ${file.name}`);
  button.title = label;
  button.append(icon(name), node("span", "action-label", label));
  button.addEventListener("click", () => action(button));
  return button;
}
function transferRow(file) {
  const item = node("li"),
    article = node("article", "transfer");
  item.dataset.fileId = file._id;
  const state = fileState(file),
    type = /\.(png|jpg|jpeg|gif|webp|svg|avif|heic)$/i.test(file.name)
      ? "image"
      : /\.(zip|rar|7z|tar|gz)$/i.test(file.name)
        ? "archive"
        : "file";
  if (file._id === sharedId) article.classList.add("highlighted");
  const nameCell = node("div", "file-name-cell"),
    fileIcon = node("span", "file-icon"),
    copy = node("div", "file-copy");
  fileIcon.dataset.kind = type;
  fileIcon.append(icon(type));
  const title = node("h3", "file-title", file.name);
  title.id = `file-${file._id}`;
  article.setAttribute("aria-labelledby", title.id);
  copy.append(
    title,
    node(
      "span",
      "file-subtitle",
      `${bytes(file.size)} · ${file.downloads} download${file.downloads === 1 ? "" : "s"}`,
    ),
  );
  nameCell.append(fileIcon, copy);
  const person = node("div", "person-cell");
  person.append(
    node(
      "span",
      "person-label",
      file.owner === identity ? "Sent to" : "Shared by",
    ),
    node(
      "span",
      "person-email",
      file.owner === identity ? file.recipient : file.owner,
    ),
  );
  const statusCell = node("div", "status-cell"),
    badge = node("span", "status-badge");
  badge.dataset.state = state.key;
  badge.append(icon(state.icon), node("span", "", state.label));
  statusCell.append(badge);
  const expiry = node("div", "expiry-cell"),
    date = new Date(file.expiresAt),
    time = node(
      "time",
      "",
      date.toLocaleDateString(undefined, { month: "short", day: "numeric" }),
    );
  time.dateTime = date.toISOString();
  expiry.title = `Access ends ${date.toLocaleString()}`;
  expiry.append(
    node(
      "span",
      "person-label",
      state.key === "expired" ? "Access ended" : "Access ends",
    ),
    time,
  );
  const actions = node("div", "row-actions");
  if (state.key === "ready")
    actions.append(
      rowAction(file, "download", "Download", (button) =>
        busy(button, async () => {
          if (config.resumable?.enabled) {
            const started = revision,
              ticket = await post(`/api/file/${file._id}/download-ticket`, {});
            if (started !== revision) return;
            if (!/^\/api\/download\/[a-f\d]{64}$/.test(ticket.url))
              throw new Error("Invalid download link. Try again.");
            const link = node("a");
            link.href = ticket.url;
            link.download = file.name;
            document.body.append(link);
            link.click();
            link.remove();
            notify("Your download has started.");
            return;
          }
          const started = revision,
            response = await api(`/api/file/${file._id}/download`),
            blob = await response.blob();
          if (started !== revision) return;
          saveBlob(blob, file.name);
          notify("Your download has started.");
          await refresh();
        }),
      ),
    );
  if (canRemove(file))
    actions.append(
      rowAction(
        file,
        "block",
        "Remove access",
        (button) =>
          confirmAction({
            title: "Remove access to this file?",
            description: `“${file.name}” will become unavailable immediately and be queued for deletion. You’ll need to send it again to restore access.`,
            label: "Remove access",
            trigger: button,
            action: async () => {
              await api(`/api/file/${file._id}`, { method: "DELETE" });
              await refresh();
              notify("Access removed. The file is queued for deletion.");
            },
          }),
        "row-remove",
      ),
    );
  if (!actions.childElementCount)
    actions.append(
      node(
        "span",
        "no-action",
        state.key === "checking"
          ? "Available after checking"
          : "No action needed",
      ),
    );
  article.append(nameCell, person, statusCell, expiry, actions);
  item.append(article);
  return item;
}
function renderFiles() {
  const counts = { ready: 0, checking: 0, downloads: 0 };
  for (const file of files) {
    const key = fileState(file).key;
    if (Object.hasOwn(counts, key)) counts[key]++;
    counts.downloads += file.downloads;
  }
  $("ready-count").textContent = counts.ready;
  $("checking-count").textContent = counts.checking;
  $("download-count").textContent = counts.downloads;
  $("nav-count").textContent = files.length;
  $("transfer-total").textContent = files.length;
  const query = $("search").value.trim().toLocaleLowerCase(),
    statusFilter = $("status-filter").value;
  const filtered = files.filter(
    (file) =>
      (direction === "all" ||
        (direction === "sent" && file.owner === identity) ||
        (direction === "received" && file.recipient === identity)) &&
      (statusFilter === "all" || fileState(file).key === statusFilter) &&
      (!query ||
        [file.name, file.owner, file.recipient].some((value) =>
          value.toLocaleLowerCase().includes(query),
        )),
  );
  filtered.sort(
    (a, b) =>
      Number(b._id === sharedId) - Number(a._id === sharedId) ||
      +new Date(b.createdAt) - +new Date(a.createdAt),
  );
  const existing = new Map(
    [...$("files").children].map((item) => [item.dataset.fileId, item]),
  );
  const focused = document.activeElement.closest("[data-file-id]"),
    focusedAction = document.activeElement.dataset.action;
  const activeId = focused?.dataset.fileId;
  const nodes = filtered.map((file) => {
    const signature = JSON.stringify([
        file,
        fileState(file).key,
        canRemove(file),
      ]),
      old = existing.get(file._id);
    if (old?.dataset.signature === signature) {
      existing.delete(file._id);
      return old;
    }
    const item = transferRow(file);
    item.dataset.signature = signature;
    existing.delete(file._id);
    return item;
  });
  // Move only rows whose order/content changed. Unchanged polling preserves focus and selection.
  nodes.forEach((item, index) => {
    const at = $("files").children[index];
    if (at !== item) $("files").insertBefore(item, at || null);
  });
  const keep = new Set(nodes);
  for (const item of [...$("files").children])
    if (!keep.has(item)) item.remove();
  if (activeId && focusedAction && document.activeElement === document.body) {
    const item = nodes.find((row) => row.dataset.fileId === activeId);
    const button = item?.querySelector(`[data-action="${focusedAction}"]`);
    button?.focus({ preventScroll: true });
    if (!button) $("transfers-title").focus({ preventScroll: true });
  }
  $("files-loading").hidden = true;
  $("empty-state").hidden = filtered.length > 0;
  const limited = files.length >= 100 ? "most recent " : "";
  $("results-count").textContent =
    `${filtered.length} of ${files.length} ${limited}transfer${files.length === 1 ? "" : "s"}`;
  document
    .querySelectorAll("[data-filter]")
    .forEach((button) =>
      button.setAttribute(
        "aria-pressed",
        String(button.dataset.filter === direction),
      ),
    );
  const filtering = !!query || direction !== "all" || statusFilter !== "all";
  $("empty-title").textContent = filtering
    ? "No files match this view."
    : canSend()
      ? "Your next handoff starts here."
      : "Your shared files will appear here.";
  $("empty-description").textContent = filtering
    ? "Try another search, or clear your filters to see all files."
    : canSend()
      ? "Send a file to someone, and you’ll see its status here."
      : "When someone shares a file with your email, you can track and download it here.";
  $("empty-action").hidden = !filtering && !canSend();
  $("empty-action").textContent = filtering
    ? "Clear filters"
    : "Send your first file";
  $("empty-action").dataset.action = filtering ? "reset" : "send";
  $("shared-message").hidden = !sharedId;
  if (sharedId)
    $("shared-message-text").textContent = files.some(
      (file) => file._id === sharedId,
    )
      ? "The file from your link is highlighted below."
      : "Looking for a shared file? Use the recipient’s email. Access may have expired or been removed.";
  $("show-shared").hidden = !files.some((file) => file._id === sharedId);
}
async function refresh() {
  if (!token) return;
  if (refreshTask?.revision === revision) return refreshTask.promise;
  const task = { revision };
  task.promise = (async () => {
    try {
      if (!(await loadOrganizations())) return;
      task.revision = revision;
      const started = revision;
      const [nextUsage, listing] = await Promise.all([
        api("/api/usage").then((response) => response.json()),
        api("/api/files").then((response) => response.json()),
      ]);
      if (started !== revision || !token) return;
      if (
        sharedId &&
        /^[a-f\d-]{36}$/.test(sharedId) &&
        !listing.files.some((file) => file._id === sharedId)
      ) {
        const targeted = await (
          await api(`/api/files?transfer=${encodeURIComponent(sharedId)}`)
        ).json();
        if (started !== revision || !token) return;
        listing.files.push(...targeted.files);
      }
      usage = nextUsage;
      files = listing.files;
      loaded = true;
      renderUsage();
      renderFiles();
      await resumable.refreshPending();
      $("refresh-error").hidden = true;
      $("sync-label").textContent = "Updates automatically";
    } catch (error) {
      if (error.expired || !token || task.revision !== revision) return;
      $("files-loading").hidden = true;
      $("refresh-error").hidden = false;
      $("refresh-error-text").textContent =
        `${loaded ? "Your last view is still available. " : ""}${error.message}`;
      $("sync-label").textContent = "Update paused";
    } finally {
      if (refreshTask === task) refreshTask = null;
    }
  })();
  refreshTask = task;
  return task.promise;
}
function resetFilters() {
  direction = "all";
  $("search").value = "";
  $("status-filter").value = "all";
  renderFiles();
}
$("search").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(renderFiles, 200);
});
$("status-filter").addEventListener("change", renderFiles);
for (const button of document.querySelectorAll("[data-filter]"))
  button.addEventListener("click", () => {
    direction = button.dataset.filter;
    renderFiles();
  });
$("empty-action").addEventListener("click", () => {
  if ($("empty-action").dataset.action === "reset") resetFilters();
  else newTransfer($("empty-action"));
});
$("show-shared").addEventListener("click", () => {
  resetFilters();
  const item = [...$("files").children].find(
    (row) => row.dataset.fileId === sharedId,
  );
  item?.scrollIntoView({ block: "center" });
});
$("refresh").addEventListener("click", () => busy($("refresh"), refresh));
$("retry-refresh").addEventListener("click", () =>
  busy($("retry-refresh"), refresh),
);
$("organization").addEventListener("change", () => {
  advanceContext();
  organization = $("organization").value;
  files = [];
  usage = null;
  loaded = false;
  $("files").replaceChildren();
  $("empty-state").hidden = true;
  $("files-loading").hidden = false;
  memberSignature = "";
  renderContext();
  resetFilters();
  $("files-loading").hidden = false;
  $("empty-state").hidden = true;
  refresh();
});
let transferStep = 0;
const transferScreens = [
  ["Choose your file.", "Start with the file you want to share."],
  ["Who is it for?", "Your recipient will sign in with this email."],
  ["Set the access window.", "Decide how long the recipient can download."],
  ["Ready to send?", "Check the details before starting your transfer."],
];
function setTransferStep(step, focus = true) {
  transferStep = step;
  document.querySelectorAll("[data-send-step]").forEach((panel) => {
    panel.hidden = Number(panel.dataset.sendStep) !== step;
  });
  document.querySelectorAll(".send-steps li").forEach((item, index) => {
    if (index === step) item.setAttribute("aria-current", "step");
    else item.removeAttribute("aria-current");
  });
  $("transfer-title").textContent = transferScreens[step][0];
  $("transfer-description").textContent = transferScreens[step][1];
  $("send-back").hidden = step === 0;
  $("send-next").hidden = step === 3;
  $("send-submit").hidden = step !== 3;
  clearError("upload-error");
  if (step === 3) {
    $("review-file").textContent = $("file").files[0]?.name || "";
    $("review-size").textContent = bytes($("file").files[0]?.size || 0);
    $("review-recipient").textContent = $("recipient").value.trim();
    $("review-expiry").textContent = $("expiry").selectedOptions[0].textContent;
  }
  if (focus) $("transfer-title").focus({ preventScroll: true });
  $("transfer-dialog").scrollTop = 0;
}
function nextTransferStep() {
  const input =
    transferStep === 0
      ? $("file")
      : transferStep === 1
        ? $("recipient")
        : $("expiry");
  if (!input.reportValidity()) return;
  setTransferStep(Math.min(3, transferStep + 1));
}
$("send-next").addEventListener("click", nextTransferStep);
$("send-back").addEventListener("click", () => {
  if (!activeUpload) setTransferStep(Math.max(0, transferStep - 1));
});
function newTransfer(trigger) {
  if (!canSend() || activeUpload) return;
  resumable.newSend();
  $("upload-form").reset();
  $("selected-file").hidden = true;
  $("drop-area").hidden = false;
  $("file").setCustomValidity("");
  $("file").removeAttribute("aria-invalid");
  $("share-result").hidden = true;
  $("send-content").hidden = false;
  $("transfer-dialog").setAttribute("aria-labelledby", "transfer-title");
  $("copy").querySelector("span").textContent = "Copy link";
  setTransferStep(0, false);
  $("share-link").value = "";
  clearError("upload-error");
  openDialog($("transfer-dialog"), trigger);
}
$("new-transfer").addEventListener("click", () =>
  newTransfer($("new-transfer")),
);
function selectedFile() {
  const file = $("file").files[0];
  clearError("upload-error");
  if (file && file.size > config.maxFileSize) {
    $("file").value = "";
    $("selected-file").hidden = true;
    $("drop-area").hidden = false;
    formError(
      "upload-error",
      `That file is ${bytes(file.size)}. Choose a file no larger than ${bytes(config.maxFileSize)}.`,
    );
    return;
  }
  $("selected-file").hidden = !file;
  $("drop-area").hidden = !!file;
  if (file) {
    $("selected-name").textContent = file.name;
    $("selected-size").textContent = bytes(file.size);
  }
}
$("file").addEventListener("change", selectedFile);
$("remove-file").addEventListener("click", () => {
  $("file").value = "";
  selectedFile();
  $("file").focus();
});
let dragDepth = 0;
$("drop-area").addEventListener("dragenter", (event) => {
  event.preventDefault();
  dragDepth++;
  $("drop-area").classList.add("is-dragging");
});
$("drop-area").addEventListener("dragover", (event) => {
  event.preventDefault();
});
$("drop-area").addEventListener("dragleave", (event) => {
  event.preventDefault();
  if (--dragDepth <= 0) {
    dragDepth = 0;
    $("drop-area").classList.remove("is-dragging");
  }
});
$("drop-area").addEventListener("drop", (event) => {
  event.preventDefault();
  dragDepth = 0;
  $("drop-area").classList.remove("is-dragging");
  if (event.dataTransfer.files.length !== 1)
    return formError("upload-error", "Choose one file for each transfer.");
  $("file").files = event.dataTransfer.files;
  selectedFile();
});
function upload(body, file, signal) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest(),
      requestToken = token;
    const abort = () => xhr.abort();
    xhr.open("POST", "/api/upload");
    xhr.timeout = 120000;
    xhr.setRequestHeader("Authorization", `Bearer ${requestToken}`);
    xhr.setRequestHeader("X-Organization-ID", organization);
    xhr.setRequestHeader("X-File-Size", String(file.size));
    xhr.upload.addEventListener("progress", (event) => {
      if (!event.lengthComputable) return;
      const percent = Math.min(
        100,
        Math.round((event.loaded / event.total) * 100),
      );
      $("upload-progress").value = percent;
      $("upload-label").textContent =
        percent < 100 ? `Uploading ${percent}%` : "Finishing your transfer…";
    });
    const finish = (error, result) => {
      signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(result);
    };
    xhr.onload = () => {
      if (xhr.status === 401 && requestToken === token)
        return finish(expiredSession());
      let result;
      try {
        result = JSON.parse(xhr.responseText);
      } catch {
        return finish(
          new Error(
            "The server returned an unreadable response. Check Transfers before retrying.",
          ),
        );
      }
      finish(
        xhr.status >= 200 && xhr.status < 300
          ? null
          : new Error(result.error || "Upload failed. Please try again."),
        result,
      );
    };
    xhr.onerror = () =>
      finish(
        new Error(
          "The upload lost its connection. Check Transfers, then try again.",
        ),
      );
    xhr.ontimeout = () =>
      finish(
        new Error("The upload took too long. Check Transfers before retrying."),
      );
    xhr.onabort = () =>
      finish(new DOMException("Upload cancelled", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) {
      finish(new DOMException("Upload cancelled", "AbortError"));
      return;
    }
    xhr.send(body);
  });
}
$("upload-form").addEventListener("submit", (event) => {
  event.preventDefault();
  if (transferStep !== 3) return nextTransferStep();
  if (!$("recipient").validity.valid || !$("file").files[0])
    return setTransferStep(0);
  busy(
    event.currentTarget,
    async () => {
      const file = $("file").files[0];
      if (!file || file.size > config.maxFileSize)
        throw new Error(
          `Choose a file no larger than ${bytes(config.maxFileSize)}.`,
        );
      const started = revision,
        body = new FormData();
      body.append("file", file);
      body.append("recipient", $("recipient").value.trim());
      body.append("expiryHours", $("expiry").value);
      activeUpload = new AbortController();
      $("upload-feedback").hidden = false;
      $("upload-progress").value = 0;
      $("upload-label").textContent = "Starting your transfer…";
      $("cancel-upload").textContent = config.resumable?.enabled
        ? "Pause upload"
        : "Cancel upload";
      const fields = [...$("upload-form").querySelectorAll("input, select")];
      fields.forEach((field) => (field.disabled = true));
      $("remove-file").disabled = true;
      $("send-back").disabled = true;
      let result;
      try {
        result = config.resumable?.enabled
          ? await resumable.send(
              file,
              {
                recipient: $("recipient").value.trim(),
                expiryHours: Number($("expiry").value),
                compression: $("compression").value,
              },
              activeUpload.signal,
            )
          : await upload(body, file, activeUpload.signal);
      } catch (error) {
        if (started === revision) refresh();
        throw error;
      } finally {
        activeUpload = null;
        $("upload-feedback").hidden = true;
        $("remove-file").disabled = false;
        $("send-back").disabled = false;
        fields.forEach((field) => (field.disabled = false));
      }
      if (started !== revision) return;
      $("share-link").value = result.shareUrl;
      $("share-filename").textContent = file.name;
      $("send-content").hidden = true;
      $("share-result").hidden = false;
      $("transfer-dialog").setAttribute("aria-labelledby", "share-title");
      $("share-title").focus({ preventScroll: true });
      $("upload-form").reset();
      await refresh();
    },
    "upload-error",
  );
});
$("cancel-upload").addEventListener("click", () => activeUpload?.abort());
$("finish-share").addEventListener("click", () => {
  $("transfer-dialog").close();
  navigate("transfers");
});
$("copy").addEventListener("click", () =>
  busy($("copy"), async () => {
    try {
      await navigator.clipboard.writeText($("share-link").value);
    } catch {
      $("share-link").focus();
      $("share-link").select();
      throw new Error(
        "Select and copy the link manually; clipboard access is unavailable.",
      );
    }
    $("copy").querySelector("span").textContent = "Copied";
    notify("Recipient link copied.");
  }),
);
function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob),
    anchor = node("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function confirmAction({ title, description, label, trigger, action }) {
  pendingConfirmation = { action, revision };
  $("confirm-title").textContent = title;
  $("confirm-description").textContent = description;
  $("confirm-action").textContent = label;
  clearError("confirm-error");
  openDialog($("confirm-dialog"), trigger);
}
$("confirm-cancel").addEventListener("click", () =>
  $("confirm-dialog").close(),
);
$("confirm-action").addEventListener("click", () =>
  busy(
    $("confirm-action"),
    async () => {
      const pending = pendingConfirmation;
      if (!pending || pending.revision !== revision)
        throw new Error(
          "The workspace has changed. Close this dialog and choose the action again.",
        );
      await pending.action();
      $("confirm-dialog").close();
    },
    "confirm-error",
  ),
);
$("create-workspace").addEventListener("click", () => {
  clearError("create-error");
  openDialog($("create-dialog"), $("create-workspace"));
});
$("create-org-form").addEventListener("submit", (event) => {
  event.preventDefault();
  busy(
    event.currentTarget,
    async () => {
      const started = revision,
        result = await post("/api/organizations", {
          name: $("org-name").value.trim(),
        });
      if (started !== revision) return;
      advanceContext();
      organization = result.organization._id;
      files = [];
      loaded = false;
      memberSignature = "";
      $("org-name").value = "";
      $("create-dialog").close();
      resetFilters();
      await refresh();
      navigate("settings");
    },
    "create-error",
  );
});
$("member-form").addEventListener("submit", (event) => {
  event.preventDefault();
  busy(
    event.currentTarget,
    async () => {
      const started = revision;
      await api(`/api/organizations/${organization}/members`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: $("member-email").value.trim(),
          role: $("member-role").value,
        }),
      });
      if (started !== revision) return;
      $("member-email").value = "";
      await loadOrganizations();
      notify("Member access saved. They can sign in with that email.");
    },
    "member-error",
  );
});
const roleDescriptions = {
  member: "Can send files and manage their own transfers.",
  viewer: "Can download files shared with them. Cannot send or remove files.",
  admin:
    "Can manage workspace files and members. Only the owner can manage other administrators.",
};
$("member-role").addEventListener("change", () => {
  $("role-description").textContent = roleDescriptions[$("member-role").value];
});
$("sandbox-form").addEventListener("submit", (event) => {
  event.preventDefault();
  busy(
    event.currentTarget,
    async () => {
      const started = revision;
      await post("/api/billing/sandbox/events", {
        eventId: crypto.randomUUID(),
        plan: $("sandbox-plan").value,
        status: "active",
      });
      if (started !== revision) return;
      await refresh();
      notify("Test plan applied. No payment was collected.");
    },
    "sandbox-error",
  );
});
$("audit-export").addEventListener("click", () =>
  busy($("audit-export"), async () => {
    const started = revision,
      response = await api("/api/audit/export"),
      blob = await response.blob();
    if (started !== revision) return;
    saveBlob(blob, "workspace-activity.ndjson");
    notify("Workspace activity exported.");
  }),
);
$("logout").addEventListener("click", () =>
  busy($("logout"), async () => {
    await post("/api/logout", {});
    signedOut();
    notify("You’ve signed out.");
    $("email").focus();
  }),
);
for (const button of document.querySelectorAll(".help-trigger"))
  button.addEventListener("click", () => openDialog($("help-dialog"), button));
for (const link of document.querySelectorAll(".brand"))
  link.addEventListener("click", (event) => {
    if (token) {
      event.preventDefault();
      navigate("transfers");
    }
  });
$("dismiss-notification").addEventListener("click", () => {
  $("notification").hidden = true;
});
setInterval(() => {
  resendLabel();
}, 1000);
setInterval(() => {
  if (token && !document.hidden) refresh();
}, 5000);
document.addEventListener("visibilitychange", () => {
  if (token && !document.hidden) refresh();
});
(async () => {
  try {
    config = await (await api("/api/config")).json();
    $("file-limit").textContent =
      `Any file type, up to ${bytes(config.maxFileSize)}`;
    if (config.inboxUrl) {
      $("local-inbox").hidden = false;
      $("inbox-link").href = config.inboxUrl;
    }
    const response = await fetch("/ready");
    if (!response.ok)
      notify(
        "The service is temporarily unavailable. Please try again shortly.",
        true,
      );
  } catch {
    notify(
      "Could not connect to the service. Refresh the page to try again.",
      true,
    );
  }
})();
