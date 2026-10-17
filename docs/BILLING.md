# Billing configuration and operations

Checkout defaults to `BILLING_MODE=off`, with an empty catalog. The app never invents commercial prices or activates a merchant account. The local Compose entitlement simulator is labeled separately and cannot override paid subscriptions or an operator suspension.

## Catalog

Set `BILLING_CATALOG` to a JSON object keyed by `pilot`, `team` or `enterprise`. Each entry contains `periodDays` (1–366) and one or more provider objects. Configure your real amounts; no example amount below is a suggested price.

| Provider | Required fields | Modes |
| --- | --- | --- |
| Stripe | `currency`, positive integer `amountMinor`, `prepaidPriceId` and/or `recurringPriceId`; `interval` = `month` or `year` for recurring | Prepaid and automatic renewal |
| M-Pesa | `currency` = `kes`, positive `amountMinor` divisible by 100 | Prepaid |
| Crypto | `currency`, positive integer `amountMinor` | Prepaid |

Supported two-decimal currencies: `kes`, `usd`, `eur`, `gbp`. Amounts are minor currency units, maximum 1,000,000,000. `periodDays` controls prepaid access; Stripe's verified current subscription period controls recurring access. The catalog's Stripe amount/currency/mode/interval must match the active provider price. Tax, discount codes, prorated upgrades and custom invoices are not offered by this checkout.

Plan limits live in `src/pilot.js`. These are enforced against original storage bytes and member/file counts before checkout and again before changing entitlements. An existing unresolved recurring subscription must be managed before another checkout. Switching prepaid plans starts a new term without refunding/prorating the earlier term; the UI states this before consent.

## Providers

Use `BILLING_MODE=test` for acceptance, then explicitly choose `live` only after verifying your accounts and prices. Test and live Stripe keys must match the mode. Credentials can be prepared while the mode remains `off`.

- **Stripe:** `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`. Configure Checkout prices and a customer billing portal. Register `/api/payments/stripe/webhook` for `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `invoice.paid`, `invoice.payment_failed`, `customer.subscription.updated` and `customer.subscription.deleted`. Raw bodies are signature checked. Current provider state is retrieved when reconciling, so an older event cannot restore an obsolete entitlement.
- **M-Pesa:** `MPESA_CONSUMER_KEY`, `MPESA_CONSUMER_SECRET`, `MPESA_SHORT_CODE`, `MPESA_PASS_KEY`. Daraja sandbox/production endpoints follow the mode. Configure an HTTPS `APP_URL`; the callback is `/api/payments/mpesa/callback`. Users supply a Kenyan `2547…` or `2541…` number and approve the STK prompt. Only an authenticated STK status query can grant access; a callback alone cannot. Unknown/timeout results stay pending for review.
- **Crypto:** provider remains configurable. The included optional adapter is `CRYPTO_PROVIDER=bitpay` with `BITPAY_POS_TOKEN`, using test/live BitPay endpoints. Configure HTTPS `APP_URL` and `/api/payments/crypto/callback`. Access requires an authenticated invoice retrieval with exact order, currency and amount, complete settlement and no payment exception. No private wallet key is stored. Other providers require an adapter and acceptance tests before activation.

Keep `.env.local` out of Git. The Compose worker has outbound network access for provider verification. `APP_URL` comes from environment configuration and defaults to local loopback; a production URL requires real HTTPS and routing. Local Mailpit is not external email delivery.

## Reconciliation

The server binds checkout to an immutable quote, explicit consent, organization and request ID. One open order per workspace and unique provider references prevent concurrent/replayed starts. Provider receipts cannot be applied to another order/workspace. Prepaid grants are atomic and idempotent. Entitlement generations bind newly paid orders to the subscription state they replace; obsolete subscription events can record historical invoices without reinstalling earlier access. Local access expiry never permits a replacement recurring checkout until the provider confirms cancellation or terminal expiry. Pending orders and verified Stripe events have leases/retries; current recurring subscriptions are polled. Expired/overdue access is denied on reads/writes even before a worker update. Operator suspension is independent of provider reconciliation.

A provider-create timeout is ambiguous: an external payment may exist even if its response was lost. The order is marked **Needs operator review** and blocks a new payment. Inspect the provider portal and server order ID before resolving it. There is no automatic “assume failed and charge again” path and no general-purpose settlement override. Operational resolution currently requires a reviewed database repair/reconciliation procedure; do not directly mark an order paid or invent a receipt. This remains a launch gate with the chosen merchant accounts.

Invoices/payments are records of confirmed provider activity. Platform **Gross recorded payments** excludes test rows and groups currencies separately. It is not net revenue: refunds, disputes, fees, taxes, accounting exports and financial-close reconciliation are not implemented. Pausing application access does not cancel automatic provider charges; use Stripe's portal to cancel renewal. No provider account, commercial price or live charge is enabled in the default pilot.

## Acceptance before live payments

Run merchant sandbox checkout/renewal/cancellation, duplicate and delayed event delivery, authentication failures, network interruption, over/underpayment where applicable, quota review and operator access suspension. Verify receipts against provider records and rehearse ambiguous-order resolution. Repository tests use official SDK/controlled provider fixtures, not live merchant settlement. Establish refund/dispute/support ownership before taking money.

Primary references: [Stripe Node SDK](https://github.com/stripe/stripe-node), [Safaricom Daraja](https://developer.safaricom.co.ke/apis), [BitPay invoices](https://developer.bitpay.com/reference/create-an-invoice).
