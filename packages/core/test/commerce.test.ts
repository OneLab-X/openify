import { and, asc, carts, checkouts, emailDeliveries, eq, inventoryAdjustments, inventoryLevels, inventoryItems, orderEvents, outboxEvents, transactions } from "@shopkit/db";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { addCartLines, cartView, getOrCreateCart, mergeCartOnLogin, updateCart, updateCartLine } from "../src/commerce/carts.js";
import { createPaymentSession, handlePaymentWebhook, startCheckout, updateCheckout, verifyCheckoutPayment, checkoutView, loadCheckout } from "../src/commerce/checkout.js";
import { requestCustomerOtp, verifyCustomerOtp } from "../src/commerce/customers.js";
import { saveDiscount } from "../src/commerce/discounts.js";
import { completeDraft, saveDraft } from "../src/commerce/drafts.js";
import { cancelOrder, getOrderAdmin, markOrderPaid, refundOrder, releaseExpiredReservation, verifyOrderStatusToken, orderStatusToken } from "../src/commerce/orders.js";
import { allocate, priceLines } from "../src/commerce/pricing.js";
import { recoverCheckout, scanAbandonedCheckouts } from "../src/commerce/recovery.js";
import { upsertCredential } from "../src/credentials.js";
import { deliverEmail, emailJob } from "../src/emails/deliver.js";
import { dispatchOutbox, type OutboxEvent } from "../src/outbox.js";
import { routeOutboxEvent, type RoutedJob } from "../src/outbox-routes.js";
import { setSetting } from "../src/settings.js";
import { ADDRESS, commerceStore, fakepay, fakepayState, orderRow, pay } from "./commerce-fixtures.js";
import { ACTOR, makeDeps, sentEmails, type TestDeps } from "./harness.js";

let deps: TestDeps;
beforeAll(async () => {
  deps = await makeDeps();
  deps.registry.register(fakepay);
});
afterAll(() => deps.close());
beforeEach(() => deps.reset());
afterEach(() => vi.useRealTimers());

async function enableEmail(storeId: string) {
  await upsertCredential(deps, ACTOR, { storeId, kind: "email", provider: "memory", mode: "live" }, { config: { fromEmail: "shop@pls.test" }, secrets: {} });
  await setSetting(deps.db, storeId, "email.active", { provider: "memory", mode: "live" });
  await setSetting(deps.db, storeId, "notifications.config", { abandonedCheckoutEnabled: true, abandonedCheckoutDelayMinutes: 60, merchantEmails: ["owner@pls.test"], alertNewOrder: true, alertPaidOrder: true });
}

/** Runs the outbox like the worker: route each event and execute email jobs inline. */
async function drainOutbox(): Promise<RoutedJob[]> {
  const jobs: RoutedJob[] = [];
  for (;;) {
    let n = 0;
    await dispatchOutbox(deps.db, async (events: OutboxEvent[]) => {
      n = events.length;
      for (const e of events) jobs.push(...(await routeOutboxEvent(deps, e)));
    });
    if (n === 0) break;
  }
  for (const j of jobs.filter((j) => j.queue === "email")) await deliverEmail(deps, emailJob.parse(j.data));
  return jobs;
}

async function levels(variantId: string) {
  const [row] = await deps.db
    .select({ available: inventoryLevels.available, committed: inventoryLevels.committed })
    .from(inventoryLevels)
    .innerJoin(inventoryItems, eq(inventoryItems.id, inventoryLevels.inventoryItemId))
    .where(eq(inventoryItems.variantId, variantId));
  return row!;
}

/** Cart with 2 × variant[0] (₹999 each) through to a chosen payment method. */
async function readyCheckout(storeId: string, variantId: string, provider = "fakepay", quantity = 2) {
  const { cart, token } = await getOrCreateCart(deps, storeId, undefined);
  await addCartLines(deps, storeId, cart, { lines: [{ variantId, quantity }] });
  const checkout = await startCheckout(deps, storeId, cart);
  await updateCheckout(deps, storeId, checkout, cart, { email: "asha@example.com", phone: "9876543210", shippingAddress: ADDRESS, paymentProvider: provider });
  return { cart, token, checkoutId: checkout.id };
}

describe("pricing", () => {
  it("allocates remainders to the largest fractions and never loses a paisa", () => {
    expect(allocate(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(allocate(10, [0, 0])).toEqual([0, 0]);
    expect(allocate(7, [5, 3, 2]).reduce((a, b) => a + b)).toBe(7);
  });

  it("computes subtotal, code discount, shipping and GST (CGST+SGST in state, IGST across)", async () => {
    const { storeId, variants } = await commerceStore(deps);
    await saveDiscount(deps, ACTOR, storeId, { title: "Ten off", code: "TEN", kind: "percentage", value: 1000 });
    const v = variants[0]!; // ₹999.00
    const priced = await priceLines(deps.db, storeId, { lines: [{ variantId: v.id, quantity: 2 }], discountCode: "ten", shippingAddress: ADDRESS });
    expect(priced.subtotal).toBe(199_800);
    expect(priced.discountTotal).toBe(19_980);
    expect(priced.shippingTotal).toBe(5_000); // 179,820 < free-over 200,000
    expect(priced.taxTotal).toBe(32_368); // 18% of 179,820 = 32,367.6
    expect(priced.taxLines.map((t) => t.title)).toEqual(["CGST", "SGST"]);
    expect(priced.total).toBe(199_800 - 19_980 + 5_000 + 32_368);

    const igst = await priceLines(deps.db, storeId, { lines: [{ variantId: v.id, quantity: 3 }], shippingAddress: { ...ADDRESS, province: "Maharashtra" } });
    expect(igst.taxLines).toEqual([{ title: "IGST", rateBps: 1800, amount: 53_946 }]);
    expect(igst.shippingTotal).toBe(0); // 299,700 ≥ free-over

    await setSetting(deps.db, storeId, "tax.config", { mode: "india_gst", pricesIncludeTax: true, defaultRateBps: 1800, registeredState: "Karnataka" });
    const incl = await priceLines(deps.db, storeId, { lines: [{ variantId: v.id, quantity: 1 }], shippingAddress: ADDRESS });
    expect(incl.taxTotal).toBe(15_239); // 99,900 × 18/118
    expect(incl.total).toBe(99_900 + 5_000);
  });

  it("reports stock, unknown codes and unshippable countries as blockers", async () => {
    const { storeId, variants } = await commerceStore(deps);
    const p = await priceLines(deps.db, storeId, { lines: [{ variantId: variants[0]!.id, quantity: 6 }], discountCode: "NOPE", shippingAddress: { ...ADDRESS, country: "US" } });
    expect(p.lines[0]!.stockIssue).toBe("Only 5 left");
    expect(p.discount.error).toMatch(/not a valid/);
    expect(p.blockers.join(" ")).toMatch(/only 5 left.*don't ship to US|don't ship/);
  });
});

describe("carts", () => {
  it("adds, merges identical lines, refuses more than stock, updates and removes", async () => {
    const { storeId, variants } = await commerceStore(deps);
    const { cart, token, created } = await getOrCreateCart(deps, storeId, undefined);
    expect(created).toBe(true);
    await addCartLines(deps, storeId, cart, { lines: [{ variantId: variants[0]!.id, quantity: 2 }] });
    await addCartLines(deps, storeId, cart, { lines: [{ variantId: variants[0]!.id, quantity: 1 }, { variantId: variants[1]!.id, quantity: 1, attributes: { Gift: "yes" } }] });
    await expect(addCartLines(deps, storeId, cart, { lines: [{ variantId: variants[0]!.id, quantity: 3 }] })).rejects.toThrow(/Only 5/);
    const again = await getOrCreateCart(deps, storeId, token);
    expect(again.cart.id).toBe(cart.id);
    let view = await cartView(deps, storeId, cart);
    expect(view.lines.map((l) => l.quantity)).toEqual([3, 1]);
    expect(view.lines[1]!.attributes).toEqual({ Gift: "yes" });
    await updateCartLine(deps, storeId, cart, view.lines[1]!.id, { quantity: 0 });
    await updateCart(deps, cart, { note: "Gift wrap please", discountCode: "BOGUS" });
    const [fresh] = await deps.db.select().from(carts).where(eq(carts.id, cart.id));
    view = await cartView(deps, storeId, fresh!);
    expect(view.lines).toHaveLength(1);
    expect(view.note).toBe("Gift wrap please");
    expect(view.discount.error).toMatch(/BOGUS/);
  });

  it("merges a guest cart into the customer's previous cart at sign-in", async () => {
    const { storeId, variants } = await commerceStore(deps);
    const old = await getOrCreateCart(deps, storeId, undefined);
    await addCartLines(deps, storeId, old.cart, { lines: [{ variantId: variants[0]!.id, quantity: 1 }] });
    const login1 = await verifyAfterOtp(storeId, "asha@example.com");
    await mergeCartOnLogin(deps, storeId, old.token, login1.customer.id);

    const guest = await getOrCreateCart(deps, storeId, undefined);
    await addCartLines(deps, storeId, guest.cart, { lines: [{ variantId: variants[0]!.id, quantity: 2 }, { variantId: variants[2]!.id, quantity: 1 }] });
    const result = await mergeCartOnLogin(deps, storeId, guest.token, login1.customer.id);
    expect(result.token).toBe(guest.token);
    const merged = await getOrCreateCart(deps, storeId, guest.token);
    const view = await cartView(deps, storeId, merged.cart);
    expect(view.lines.map((l) => [l.variantId, l.quantity])).toEqual([
      [variants[0]!.id, 3],
      [variants[2]!.id, 1],
    ]);
    expect((await getOrCreateCart(deps, storeId, old.token)).created).toBe(true); // old cart is closed
  });
});

async function verifyAfterOtp(storeId: string, email: string) {
  await requestCustomerOtp(deps, storeId, { email });
  const [event] = await deps.db.select().from(outboxEvents).where(eq(outboxEvents.type, "customer.otp_requested")).orderBy(asc(outboxEvents.createdAt));
  const code = String((event!.payload as { code: string }).code);
  await deps.db.delete(outboxEvents);
  return verifyCustomerOtp(deps, storeId, { email, code });
}

describe("checkout and payments", () => {
  it("prices from the database, reserves stock at session time and places the order once", async () => {
    const { storeId, variants } = await commerceStore(deps);
    await enableEmail(storeId);
    const v = variants[0]!;
    const { token, checkoutId } = await readyCheckout(storeId, v.id);
    const loaded = await loadCheckout(deps.db, storeId, checkoutId, token);
    const view = await checkoutView(deps, storeId, loaded.checkout, loaded.cart);
    expect(view.missing).toEqual([]);

    const session = await createPaymentSession(deps, storeId, checkoutId, token);
    expect(session.flow).toBe("widget");
    // The provider was asked for exactly the server total (2 × ₹999 + ₹50 shipping + 18% GST).
    const expected = 199_800 + 5_000 + 35_964;
    expect(fakepayState.sessions).toEqual([{ amount: expected, orderId: session.orderId }]);
    expect(await levels(v.id)).toEqual({ available: 3, committed: 2 });

    const { returnPayload, webhook } = pay(String(session.clientPayload.orderId));
    // Browser return (fast path) and webhook (source of truth) both arrive.
    const verified = await verifyCheckoutPayment(deps, storeId, checkoutId, token, returnPayload);
    expect(verified.status).toBe("paid");
    const hook = webhook();
    expect((await handlePaymentWebhook(deps, "fakepay", hook.body, hook.headers)).outcome).toBe("ignored");
    expect((await handlePaymentWebhook(deps, "fakepay", hook.body, hook.headers)).outcome).toBe("duplicate");

    const order = await orderRow(deps, session.orderId);
    expect(order).toMatchObject({ name: "#1001", financialStatus: "paid", amountPaid: expected, inventoryState: "reserved" });
    expect(await levels(v.id)).toEqual({ available: 3, committed: 2 });
    const ledger = await deps.db.select().from(inventoryAdjustments).where(eq(inventoryAdjustments.reason, "order"));
    expect(ledger).toHaveLength(2); // available −2 and committed +2, once
    expect(await deps.db.select().from(transactions).where(eq(transactions.orderId, order.id))).toHaveLength(1);

    await drainOutbox();
    await drainOutbox();
    const confirmations = sentEmails.filter((m) => m.to === "asha@example.com" && /confirmed/.test(m.subject));
    expect(confirmations).toHaveLength(1);
    expect(confirmations[0]!.html).toContain("Block Print Tee");
    expect(sentEmails.filter((m) => m.to === "owner@pls.test" && /New order #1001/.test(m.subject))).toHaveLength(1);
    expect(await deps.db.select().from(emailDeliveries).where(eq(emailDeliveries.orderId, order.id))).toHaveLength(2);

    expect(verifyOrderStatusToken(deps, orderStatusToken(deps, order.id))).toBe(order.id);
    expect(verifyOrderStatusToken(deps, `${order.id}.forged`)).toBeNull();
    const [co] = await deps.db.select().from(checkouts).where(eq(checkouts.id, checkoutId));
    expect(co!.status).toBe("completed");
  });

  it("the webhook alone places the order, and replaying it changes nothing", async () => {
    const { storeId, variants } = await commerceStore(deps);
    await enableEmail(storeId);
    const { token, checkoutId } = await readyCheckout(storeId, variants[0]!.id);
    const session = await createPaymentSession(deps, storeId, checkoutId, token);
    const hook = pay(String(session.clientPayload.orderId)).webhook();
    expect((await handlePaymentWebhook(deps, "fakepay", hook.body, hook.headers)).outcome).toBe("applied");
    for (let i = 0; i < 3; i++) expect((await handlePaymentWebhook(deps, "fakepay", hook.body, hook.headers)).outcome).toBe("duplicate");
    await drainOutbox();
    expect(sentEmails.filter((m) => /confirmed/.test(m.subject))).toHaveLength(1);
    expect((await orderRow(deps, session.orderId)).financialStatus).toBe("paid");
    expect(await levels(variants[0]!.id)).toEqual({ available: 3, committed: 2 });
    await expect(handlePaymentWebhook(deps, "fakepay", hook.body, { "x-fakepay-signature": "forged" })).rejects.toThrow(/signature/);
  });

  it("ignores amounts from the browser: a short payment is flagged, not accepted as full", async () => {
    const { storeId, variants } = await commerceStore(deps);
    const { token, checkoutId } = await readyCheckout(storeId, variants[0]!.id);
    const session = await createPaymentSession(deps, storeId, checkoutId, token);
    const order = await orderRow(deps, session.orderId);
    const hook = pay(String(session.clientPayload.orderId), { amount: 100 }).webhook();
    await handlePaymentWebhook(deps, "fakepay", hook.body, hook.headers);
    const after = await orderRow(deps, session.orderId);
    expect(after.financialStatus).toBe("partially_paid");
    expect(after.amountPaid).toBe(100);
    expect(after.total).toBe(order.total);
    const events = await deps.db.select().from(orderEvents).where(and(eq(orderEvents.orderId, order.id), eq(orderEvents.type, "payment_mismatch")));
    expect(events).toHaveLength(1);
  });

  it("rejects a return for a payment that belongs to another checkout", async () => {
    const { storeId, variants } = await commerceStore(deps);
    const a = await readyCheckout(storeId, variants[0]!.id, "fakepay", 1);
    const b = await readyCheckout(storeId, variants[1]!.id, "fakepay", 1);
    await createPaymentSession(deps, storeId, a.checkoutId, a.token);
    const sb = await createPaymentSession(deps, storeId, b.checkoutId, b.token);
    const { returnPayload } = pay(String(sb.clientPayload.orderId));
    await expect(verifyCheckoutPayment(deps, storeId, a.checkoutId, a.token, returnPayload)).rejects.toThrow(/does not belong/);
    await expect(verifyCheckoutPayment(deps, storeId, b.checkoutId, "wrong-token", returnPayload)).rejects.toThrow(/not found/);
  });

  it("releases the reservation when the delayed job runs after the timeout, and re-takes it for a late payment", async () => {
    const { storeId, variants } = await commerceStore(deps);
    const { token, checkoutId } = await readyCheckout(storeId, variants[0]!.id);
    const session = await createPaymentSession(deps, storeId, checkoutId, token);
    expect(await releaseExpiredReservation(deps, storeId, session.orderId)).toBe(false); // not due yet
    const t0 = Date.now();
    vi.useFakeTimers({ now: t0 + 31 * 60_000, toFake: ["Date"] });
    expect(await releaseExpiredReservation(deps, storeId, session.orderId)).toBe(true);
    expect(await levels(variants[0]!.id)).toEqual({ available: 5, committed: 0 });
    vi.useRealTimers();
    const hook = pay(String(session.clientPayload.orderId)).webhook();
    await handlePaymentWebhook(deps, "fakepay", hook.body, hook.headers);
    expect(await levels(variants[0]!.id)).toEqual({ available: 3, committed: 2 });
    expect((await orderRow(deps, session.orderId)).placedAt).not.toBeNull();
  });

  it("refuses to start payment when stock ran out after the cart was filled", async () => {
    const { storeId, variants } = await commerceStore(deps);
    const a = await readyCheckout(storeId, variants[0]!.id, "fakepay", 4);
    const b = await readyCheckout(storeId, variants[0]!.id, "fakepay", 4);
    await createPaymentSession(deps, storeId, a.checkoutId, a.token);
    await expect(createPaymentSession(deps, storeId, b.checkoutId, b.token)).rejects.toThrow(/only 1 left/i);
  });

  it("cash on delivery places the order unpaid; staff mark it paid, refund and cancel with restock", async () => {
    const { storeId, variants } = await commerceStore(deps);
    await enableEmail(storeId);
    const { token, checkoutId } = await readyCheckout(storeId, variants[0]!.id, "cod");
    const session = await createPaymentSession(deps, storeId, checkoutId, token);
    expect(session.flow).toBe("offline");
    expect(session.orderStatusToken).toBeTruthy();
    let order = await orderRow(deps, session.orderId);
    expect(order).toMatchObject({ name: "#1001", financialStatus: "pending" });

    await markOrderPaid(deps, ACTOR, storeId, order.id);
    await refundOrder(deps, ACTOR, storeId, order.id, { amount: 10_000, reason: "Late delivery" });
    order = await orderRow(deps, order.id);
    expect(order).toMatchObject({ financialStatus: "partially_refunded", amountRefunded: 10_000 });

    await cancelOrder(deps, ACTOR, storeId, order.id, { reason: "customer", restock: true, refund: true });
    order = await orderRow(deps, order.id);
    expect(order).toMatchObject({ status: "cancelled", financialStatus: "refunded", amountRefunded: order.amountPaid });
    expect(await levels(variants[0]!.id)).toEqual({ available: 5, committed: 0 });
    await drainOutbox();
    expect(sentEmails.map((m) => m.subject)).toEqual(
      expect.arrayContaining([expect.stringMatching(/#1001 confirmed/), expect.stringMatching(/Refund for order #1001/), expect.stringMatching(/#1001 has been cancelled/)]),
    );
    const view = await getOrderAdmin(deps, storeId, order.id);
    expect(view.events.map((e) => e.type)).toEqual(expect.arrayContaining(["placed", "marked_paid", "refunded", "cancelled"]));
  });

  it("refunds online payments through the provider with our refund id as the idempotency key", async () => {
    const { storeId, variants } = await commerceStore(deps);
    const { token, checkoutId } = await readyCheckout(storeId, variants[0]!.id);
    const session = await createPaymentSession(deps, storeId, checkoutId, token);
    const hook = pay(String(session.clientPayload.orderId)).webhook();
    await handlePaymentWebhook(deps, "fakepay", hook.body, hook.headers);
    const order = await orderRow(deps, session.orderId);
    const lines = (await getOrderAdmin(deps, storeId, order.id)).lines;
    const { refundId } = await refundOrder(deps, ACTOR, storeId, order.id, { amount: 50_000, lines: [{ orderLineId: lines[0]!.id, quantity: 1, restock: true }] });
    expect(fakepayState.refunds).toEqual([{ paymentId: `fp_pay_${String(session.clientPayload.orderId)}`, amount: 50_000, key: refundId }]);
    expect(await levels(variants[0]!.id)).toEqual({ available: 4, committed: 1 });
    await expect(refundOrder(deps, ACTOR, storeId, order.id, { amount: order.total })).rejects.toThrow(/at most/);
  });

  it("a failed payment emails the customer once and leaves the checkout open", async () => {
    const { storeId, variants } = await commerceStore(deps);
    await enableEmail(storeId);
    const { token, checkoutId } = await readyCheckout(storeId, variants[0]!.id);
    const session = await createPaymentSession(deps, storeId, checkoutId, token);
    const failed = pay(String(session.clientPayload.orderId), { status: "failed" }).webhook();
    await handlePaymentWebhook(deps, "fakepay", failed.body, failed.headers);
    await handlePaymentWebhook(deps, "fakepay", failed.body, failed.headers);
    await drainOutbox();
    expect(sentEmails.filter((m) => /didn't go through/.test(m.subject))).toHaveLength(1);
    expect((await orderRow(deps, session.orderId)).placedAt).toBeNull();
  });
});

describe("abandoned checkouts", () => {
  it("emails once after the configured delay (fake timers) with a working recovery link", async () => {
    const { storeId, variants } = await commerceStore(deps);
    await enableEmail(storeId);
    const t0 = new Date("2026-11-19T10:00:00Z").getTime();
    vi.useFakeTimers({ now: t0, toFake: ["Date"] });
    const { checkoutId } = await readyCheckout(storeId, variants[0]!.id);

    vi.setSystemTime(t0 + 59 * 60_000);
    expect(await scanAbandonedCheckouts(deps, storeId)).toBe(0);
    vi.setSystemTime(t0 + 61 * 60_000);
    expect(await scanAbandonedCheckouts(deps, storeId)).toBe(1);
    expect(await scanAbandonedCheckouts(deps, storeId)).toBe(0);
    await drainOutbox();
    const reminders = sentEmails.filter((m) => /left something/.test(m.subject));
    expect(reminders).toHaveLength(1);
    const link = /href="([^"]+\/checkouts\/recover\/[^"]+)"/.exec(reminders[0]!.html)![1]!;
    const recovered = await recoverCheckout(deps, storeId, decodeURIComponent(link.split("/recover/")[1]!));
    expect(recovered?.checkoutId).toBe(checkoutId);
    expect((await getOrCreateCart(deps, storeId, recovered!.cartToken)).created).toBe(false);
    expect(await recoverCheckout(deps, storeId, `${checkoutId}.forged`)).toBeNull();
  });
});

describe("customers, discounts and drafts", () => {
  it("signs in with an emailed code, creating the account on first use", async () => {
    const { storeId } = await commerceStore(deps);
    const login = await verifyAfterOtp(storeId, "New.Person@Example.com");
    expect(login.customer.email).toBe("new.person@example.com");
    await requestCustomerOtp(deps, storeId, { email: "new.person@example.com" });
    for (let i = 0; i < 5; i++) await expect(verifyCustomerOtp(deps, storeId, { email: "new.person@example.com", code: "000000" })).rejects.toThrow(/wrong or has expired/);
  });

  it("limits a once-per-customer code and counts usage when the order is placed", async () => {
    const { storeId, variants } = await commerceStore(deps);
    await saveDiscount(deps, ACTOR, storeId, { title: "Welcome", code: "WELCOME", kind: "fixed_amount", value: 10_000, oncePerCustomer: true });
    const first = await readyCheckout(storeId, variants[0]!.id, "cod", 1);
    const { cart } = await loadCheckout(deps.db, storeId, first.checkoutId, first.token);
    await updateCart(deps, cart, { discountCode: "welcome" });
    const s = await createPaymentSession(deps, storeId, first.checkoutId, first.token);
    expect((await orderRow(deps, s.orderId)).discountTotal).toBe(10_000);

    const second = await readyCheckout(storeId, variants[1]!.id, "cod", 1);
    const c2 = await loadCheckout(deps.db, storeId, second.checkoutId, second.token);
    await updateCart(deps, c2.cart, { discountCode: "WELCOME" });
    await expect(createPaymentSession(deps, storeId, second.checkoutId, second.token)).rejects.toThrow(/once per customer/);
  });

  it("completes a draft order as paid with the same pricing", async () => {
    const { storeId, variants } = await commerceStore(deps);
    const draft = await saveDraft(deps, ACTOR, storeId, {
      email: "walkin@example.com",
      lines: [{ variantId: variants[0]!.id, quantity: 1 }],
      shippingAddress: ADDRESS,
      shippingLine: { title: "Courier", amount: 7_000 },
      discount: { kind: "percentage", value: 500, reason: "Friend" },
    });
    expect(draft.name).toBe("D1");
    expect(draft.discountTotal).toBe(4_995);
    const { orderId } = await completeDraft(deps, ACTOR, storeId, draft.id, { paymentPending: false });
    const order = await orderRow(deps, orderId);
    expect(order).toMatchObject({ sourceName: "draft", financialStatus: "paid", total: draft.total, shippingTotal: 7_000 });
    expect(await levels(variants[0]!.id)).toEqual({ available: 4, committed: 1 });
  });
});
