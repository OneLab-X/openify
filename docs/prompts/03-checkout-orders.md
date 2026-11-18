# 03 — Cart, checkout, payments, orders, customers

Prepend `00-master-context.md`, then:

```
Phase 3 — Cart, checkout, payments, orders, customers. Read SPEC §7 (PaymentProvider and
"Payment flow"), §8 (Customers, Commerce), §10, §13, and docs/PLS-REFERENCE.md (payments,
orders, email sections).

Build:
1. Carts: guest and customer carts (cookie id), add/update/remove lines, merge on login,
   stock checks, cart notes and attributes.
2. Checkout: contact → shipping address → shipping rate → payment, one-page responsive UI.
   Pricing service in packages/core computes subtotal, discounts (basic codes now, full
   engine in Phase 4), shipping, tax and total; same function used by cart, checkout and
   order creation. Inventory reserved at payment-session time, released by a delayed job
   if unpaid (configurable timeout).
3. Payments, generalising the PLS Razorpay flow (create session → widget/redirect → verify
   return → webhook as source of truth, idempotent by event id): Razorpay (done in Phase 1,
   wire to checkout), Stripe (Payment Intents + webhooks), PayPal, Cashfree, PhonePe,
   manual bank transfer (order stays pending until marked paid), Cash on Delivery.
   Each adapter passes a shared contract test suite with recorded fixtures.
4. Orders: per-store number sequence with prefix, financial/fulfillment/status split per
   SPEC §8, order timeline (order_events), staff notes, tags, transactions table, manual
   order creation and draft orders in admin, cancel with restock + refund option.
5. Customers: accounts with email OTP (default) or password, addresses, order history,
   marketing consent, tags, admin customer list/detail with lifetime value.
6. Emails (React Email, sent via outbox → email queue, idempotency key per order+template):
   order confirmation, payment failed, order cancelled, shipping update, refund, customer
   OTP, abandoned checkout (delay configurable). Merchant alert emails for new/paid orders.
   Templates editable (subject + intro text) in Settings → Notifications.
7. Thank-you page and order status page accessed by signed token (no login needed);
   customer account order pages.

Done when:
- Playwright buys a product end-to-end with Razorpay test mode and with Stripe test mode;
- replaying the same webhook is a no-op; confirmation email is sent exactly once; inventory
  is decremented exactly once; tampered amounts from the browser are ignored;
- abandoned checkout email fires after the delay in an integration test with fake timers.
```
