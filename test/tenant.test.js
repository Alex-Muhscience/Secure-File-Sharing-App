const { test } = require("node:test");
const assert = require("node:assert/strict");
const { canAccess } = require("../src/pilot");
test("paid access expires before the worker runs and operator pauses cannot be bypassed", () => {
  const org = {
    _id: "workspace",
    status: "active",
    members: [{ email: "owner@example.com", role: "owner" }],
    subscription: {
      provider: "stripe",
      mode: "recurring",
      status: "active",
      periodEnd: new Date(Date.now() + 86400000),
    },
  };
  const file = { owner: "owner@example.com" };
  assert.equal(canAccess(org, file, file.owner, org._id, "read"), true);
  assert.equal(
    canAccess(
      { ...org, subscription: { ...org.subscription, periodEnd: new Date(0) } },
      file,
      file.owner,
      org._id,
      "read",
    ),
    false,
  );
  assert.equal(
    canAccess(
      { ...org, adminSuspended: true },
      file,
      file.owner,
      org._id,
      "read",
    ),
    false,
  );
  assert.equal(
    canAccess(
      { ...org, subscription: { ...org.subscription, periodEnd: undefined } },
      file,
      file.owner,
      org._id,
      "read",
    ),
    false,
  );
});
