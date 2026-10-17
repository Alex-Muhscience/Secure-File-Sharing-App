const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { MongoClient } = require('mongodb');
const { initialize } = require('../src/database');
const { Payments } = require('../src/payments');
async function setup(t) {
  const client = new MongoClient(process.env.TEST_MONGO_URI || 'mongodb://mongo:27017'); await client.connect();
  const db = client.db(`payment_ordering_${crypto.randomBytes(6).toString('hex')}`);
  t.after(async () => { await db.dropDatabase(); await client.close(); }); await initialize(db);
  const org = { _id: crypto.randomUUID(), owner: 'owner@example.com', members: [{ email: 'owner@example.com', role: 'owner' }], plan: 'pilot', status: 'active', usedBytes: 0, fileCount: 0 };
  await db.collection('organizations').insertOne(org);
  const states = new Map(), config = { payments: { mode: 'test', catalog: { team: { periodDays: 30, stripe: { amountMinor: 10000, currency: 'kes', recurringPriceId: 'price_fixture', interval: 'month' }, mpesa: { amountMinor: 10000, currency: 'kes' } } } } };
  const gateway = { available: () => true, async create(order) { return { externalId: `ext_${order._id}` }; }, async verify(order) { return { status: 'paid', paymentId: order.externalId, ...(order.mode === 'recurring' ? { subscriptionId: order.subscriptionId } : {}) }; }, async subscription(id) { return { ...states.get(id) }; } };
  const payments = new Payments({ config, db, gateway });
  async function order(provider, subscriptionId) {
    const current = await db.collection('organizations').findOne({ _id: org._id });
    const row = { _id: crypto.randomUUID(), externalId: `ext_${crypto.randomUUID()}`, orgId: org._id, provider, plan: 'team', mode: provider === 'stripe' ? 'recurring' : 'prepaid', amountMinor: 10000, currency: 'kes', periodDays: 30, status: 'pending', open: true, test: true, entitlementEpoch: current.entitlementEpoch || 0, subscriptionId };
    await db.collection('orders').insertOne(row);
    if (subscriptionId) states.set(subscriptionId, { id: subscriptionId, orderId: row._id, orgId: org._id, plan: 'team', customerId: `cus_${subscriptionId}`, active: true, status: 'active', periodEnd: new Date(Date.now() + 30 * 86400000), invoice: null });
    await payments.reconcile(row._id); return row;
  }
  const current = () => db.collection('organizations').findOne({ _id: org._id });
  return { db, org, states, payments, gateway, order, current };
}
test('an obsolete Stripe subscription cannot reinstall itself after prepaid or replacement recurring access', async t => {
  const fixture = await setup(t), { states, payments, order, current, db } = fixture;
  await order('stripe', 'sub_old'); states.set('sub_old', { ...states.get('sub_old'), active: false, status: 'canceled' });
  await payments.syncSubscription('sub_old');
  await order('mpesa'); const prepaid = await current(); assert.equal(prepaid.subscription.provider, 'mpesa');
  states.get('sub_old').invoice = { id: 'in_historical', subscription: 'sub_old', customer: 'cus_sub_old', status: 'paid', currency: 'kes', amount_paid: 10000, livemode: false, created: Math.floor(Date.now() / 1000) };
  await payments.syncSubscription('sub_old');
  assert.deepEqual((await current()).subscription, prepaid.subscription, 'Old canceled Stripe state must not replace prepaid access');
  assert.equal(await db.collection('invoices').countDocuments({ _id: 'stripe:in_historical' }), 1, 'Historical invoices remain recorded');
  await order('stripe', 'sub_new'); const replacement = await current();
  assert.equal(replacement.subscription.externalId, 'sub_new');
  await payments.syncSubscription('sub_old');
  assert.deepEqual((await current()).subscription, replacement.subscription, 'Old subscription must not replace a newer recurring contract');
});
test('a prepaid grant wins over an obsolete subscription response held during reconciliation', async t => {
  const { states, payments, gateway, order, current } = await setup(t);
  await order('stripe', 'sub_old'); states.set('sub_old', { ...states.get('sub_old'), active: false, status: 'canceled' }); await payments.syncSubscription('sub_old');
  let release, started, calls = 0;
  const blocked = new Promise(resolve => { started = resolve; }), gate = new Promise(resolve => { release = resolve; });
  const original = gateway.subscription;
  gateway.subscription = async id => { const snapshot = await original(id); if (++calls === 2) { started(); await gate; } return snapshot; };
  const delayed = payments.syncSubscription('sub_old'); t.after(() => { release(); return delayed; }); await blocked;
  await order('mpesa'); const prepaid = await current(); release(); await delayed;
  assert.deepEqual((await current()).subscription, prepaid.subscription, 'A delayed provider response cannot overwrite the newly granted order');
});
test('local access expiry does not permit replacement checkout for a possibly billable recurring subscription', async t => {
  const { org, db, current, payments } = await setup(t);
  await db.collection('organizations').updateOne({ _id: org._id }, { $set: { subscription: { provider: 'stripe', mode: 'recurring', status: 'expired', externalId: 'sub_provider_unavailable', periodEnd: new Date(0) }, status: 'suspended' } });
  await assert.rejects(payments.checkout({ identity: org.owner, org: { ...await current(), role: 'owner' }, body: { provider: 'stripe', plan: 'team', mode: 'recurring', requestId: crypto.randomUUID(), acceptTerms: true, quoteId: payments.quote('team', 'stripe', 'recurring') } }), error => error.status === 409);
  assert.equal(await db.collection('orders').countDocuments(), 0, 'No second external checkout was started');
});
