const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const Stripe = require('stripe');
const { PaymentProviders } = require('../src/payment-providers');
test('official Stripe SDK checks catalog prices, checkout ownership, payment mode and current subscription state', async t => {
  let amount = 9999, paid = false, session, subscriptionStatus = 'active'; const requests = [];
  const periodEnd = Math.floor(Date.now() / 1000) + 2592000;
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const url = new URL(req.url, 'http://localhost'), params = new URLSearchParams(raw); requests.push({ path: url.pathname, params, headers: req.headers });
    let data;
    if (url.pathname.startsWith('/v1/prices/')) data = { id: url.pathname.split('/').at(-1), active: true, unit_amount: amount, currency: 'kes', livemode: false, recurring: url.pathname.endsWith('price_recurring') ? { interval: 'month', interval_count: 1 } : null };
    else if (req.method === 'POST') {
      session = { id: 'cs_test_fixture', url: 'https://checkout.stripe.com/c/pay/fixture', mode: params.get('mode'), client_reference_id: params.get('client_reference_id'), metadata: { orderId: params.get('metadata[orderId]'), orgId: params.get('metadata[orgId]') }, amount_total: 10000, currency: 'kes', livemode: false, subscription: 'sub_fixture', payment_intent: 'pi_fixture' }; data = session;
    } else if (url.pathname.startsWith('/v1/subscriptions/')) data = { id: 'sub_fixture', status: subscriptionStatus, livemode: false, customer: 'cus_fixture', metadata: session.metadata, items: { data: [{ quantity: 1, price: { id: 'price_recurring' }, current_period_end: periodEnd }] }, latest_invoice: { id: 'in_fixture', number: 'INV-FIXTURE', status: 'paid', currency: 'kes', amount_paid: 10000, created: Math.floor(Date.now() / 1000), livemode: false } };
    else data = { ...session, status: paid ? 'complete' : 'open', payment_status: paid ? 'paid' : 'unpaid' };
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data));
  });
  server.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const sdk = new Stripe('sk_test_fixture', { host: '127.0.0.1', port: server.address().port, protocol: 'http', maxNetworkRetries: 0 });
  const gateway = new PaymentProviders({ baseUrl: 'https://files.example.com', payments: { mode: 'test', stripe: { webhookSecret: 'whsec_fixture' }, catalog: { team: { periodDays: 30, stripe: { currency: 'kes', amountMinor: 10000, prepaidPriceId: 'price_prepaid', recurringPriceId: 'price_recurring', interval: 'month' } } } } }, { stripe: sdk });
  const order = { _id: 'order_fixture', orgId: 'workspace_fixture', owner: 'owner@example.com', provider: 'stripe', plan: 'team', mode: 'prepaid', currency: 'kes', amountMinor: 10000 };
  await assert.rejects(gateway.create(order), /price/i); assert.equal(requests.filter(req => req.path === '/v1/checkout/sessions').length, 0);
  amount = 10000; const checkout = await gateway.create(order);
  const outgoing = requests.at(-1); assert.equal(outgoing.params.get('mode'), 'payment'); assert.equal(outgoing.headers['idempotency-key'], order._id);
  assert.equal((await gateway.verify({ ...order, externalId: checkout.externalId })).status, 'pending');
  paid = true; assert.equal((await gateway.verify({ ...order, externalId: checkout.externalId })).status, 'paid');
  const originalMode = session.mode; session.mode = 'subscription';
  await assert.rejects(gateway.verify({ ...order, externalId: checkout.externalId }), /match|mode/i);
  session.mode = originalMode;
  await assert.rejects(gateway.verify({ ...order, amountMinor: 1, externalId: checkout.externalId }), /match/i);
  const recurring = { ...order, _id: 'order_recurring', mode: 'recurring' }; await gateway.create(recurring);
  assert.equal(requests.at(-1).params.get('subscription_data[metadata][orderId]'), recurring._id);
  const snapshot = await gateway.subscription('sub_fixture'); assert.equal(snapshot.active, true); assert.equal(+snapshot.periodEnd, periodEnd * 1000);
  subscriptionStatus = 'canceled'; assert.equal((await gateway.subscription('sub_fixture')).active, false);
});
