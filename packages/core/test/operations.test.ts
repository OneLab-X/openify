import { and, eq, giftCardTransactions, giftCards, inventoryItems, inventoryLevels, orderLines, orders, refunds, returns, transactions } from "@shopkit/db";
import type { ProviderDefinition, TrackingWebhookEvent } from "@shopkit/providers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createCollection } from "../src/catalog/collections.js";
import { applyInventoryChanges, createLocation } from "../src/catalog/inventory.js";
import { addCartLines, getOrCreateCart, updateCart } from "../src/commerce/carts.js";
import { createPaymentSession, handlePaymentWebhook, startCheckout, updateCheckout } from "../src/commerce/checkout.js";
import { saveDiscount } from "../src/commerce/discounts.js";
import { cancelFulfillment, createFulfillment, handleShippingWebhook, listFulfillments, updateFulfillmentTracking, whatsappDeliveryLink } from "../src/commerce/fulfillments.js";
import { getGiftCard, issueGiftCard } from "../src/commerce/gift-cards.js";
import { getInvoice, indianWords, renderInvoicePdf, rupeesInWords } from "../src/commerce/invoices.js";
import { releaseExpiredReservation } from "../src/commerce/orders.js";
import { priceLines } from "../src/commerce/pricing.js";
import { calculateRefund, refundOrder } from "../src/commerce/refunds.js";
import { approveReturn, receiveReturn, requestReturn, resolveReturn, returnableQuantities } from "../src/commerce/returns.js";
import { saveRate, saveZone } from "../src/commerce/shipping.js";
import { saveTaxOverride, saveTaxRate } from "../src/commerce/tax.js";
import { upsertCredential } from "../src/credentials.js";
import { setSetting } from "../src/settings.js";
import { ADDRESS, commerceStore, orderRow, pay, refundWebhook, fakepayState } from "./commerce-fixtures.js";
import { ACTOR, makeDeps, type TestDeps } from "./harness.js";

let deps: TestDeps;
beforeAll(async () => {
  deps = await makeDeps();
  const { fakepay } = await import("./commerce-fixtures.js");
  deps.registry.register(fakepay).register(fakeShip);
});
afterAll(() => deps.close());
beforeEach(() => deps.reset());

// ── A fake carrier adapter ───────────────────────────────────────────────────
const shipped: { reference: string; rateId: string | null | undefined; weight: number }[] = [];
const fakeShip: ProviderDefinition<"shipping", { origin?: string }, { token: string }> = {
  id: "fakeship",
  kind: "shipping",
  displayName: "FakeShip",
  modes: ["live"],
  configSchema: z.object({ origin: z.string().optional() }),
  secretsSchema: z.object({ token: z.string() }),
  create: (ctx) => ({
    testCredentials: () => Promise.resolve({ ok: true }),
    rates: (r) => Promise.resolve([{ id: "fs-eco", name: "Economy", amount: r.parcel.weightGrams > 1000 ? 12_000 : 6_000, currency: "INR", etaDays: 5 }, { id: "fs-exp", name: "Express", amount: 15_000, currency: "INR" }]),
    createShipment: (i) => {
      shipped.push({ reference: i.reference, rateId: i.rateId, weight: i.parcel.weightGrams });
      return Promise.resolve({ shipmentId: `shp-${shipped.length}`, awb: `FS${1000 + shipped.length}`, carrier: "FakeShip", labelUrl: "https://fakeship.test/label.pdf", trackingUrl: null });
    },
    label: () => Promise.resolve("https://fakeship.test/label.pdf"),
    track: () => Promise.resolve({ state: "in_transit", description: "In transit", events: [] }),
    parseWebhook: (raw, headers) => {
      if (headers["x-token"] !== ctx.secrets.token) return Promise.reject(new Error("bad token"));
      return Promise.resolve(JSON.parse(raw.toString()) as TrackingWebhookEvent[]);
    },
    trackingUrl: (awb) => `https://fakeship.test/t/${awb}`,
  }),
};

async function level(variantId: string, locationId?: string) {
  const rows = await deps.db
    .select({ available: inventoryLevels.available, committed: inventoryLevels.committed, locationId: inventoryLevels.locationId })
    .from(inventoryLevels)
    .innerJoin(inventoryItems, eq(inventoryItems.id, inventoryLevels.inventoryItemId))
    .where(eq(inventoryItems.variantId, variantId));
  const r = locationId ? rows.find((x) => x.locationId === locationId) : rows[0];
  return { available: r?.available ?? 0, committed: r?.committed ?? 0 };
}

/** Checkout through payment with FakePay; returns the placed, paid order. */
async function paidOrder(storeId: string, lines: { variantId: string; quantity: number }[], address = ADDRESS) {
  const { cart, token } = await getOrCreateCart(deps, storeId, undefined);
  await addCartLines(deps, storeId, cart, { lines });
  const checkout = await startCheckout(deps, storeId, cart);
  await updateCheckout(deps, storeId, checkout, cart, { email: "asha@example.com", phone: "9876543210", shippingAddress: address, paymentProvider: "fakepay" });
  const session = await createPaymentSession(deps, storeId, checkout.id, token);
  const hook = pay(String(session.clientPayload.orderId)).webhook();
  await handlePaymentWebhook(deps, "fakepay", hook.body, hook.headers);
  return orderRow(deps, session.orderId);
}

async function linesOf(orderId: string) {
  return deps.db.select().from(orderLines).where(eq(orderLines.orderId, orderId)).orderBy(orderLines.position);
}

describe("order lifecycle: fulfil, refund, return", () => {
  it("paid → partially fulfilled → fulfilled (two locations) → partial refund with restock → return received", async () => {
    const { storeId, variants } = await commerceStore(deps);
    const [a, b] = [variants[0]!, variants[1]!];
    const main = (await deps.db.select().from(inventoryLevels).innerJoin(inventoryItems, eq(inventoryItems.id, inventoryLevels.inventoryItemId)).where(eq(inventoryItems.variantId, a.id)))[0]!.inventory_levels.locationId;
    const warehouse = await createLocation(deps, ACTOR, storeId, { name: "Warehouse B" });
    const [itemB] = await deps.db.select().from(inventoryItems).where(eq(inventoryItems.variantId, b.id));
    await applyInventoryChanges(deps.db, ACTOR, storeId, [{ inventoryItemId: itemB!.id, locationId: warehouse.id, quantity: "available", set: 4 }], "received");

    // 2 × A + 1 × B, ₹999 each, 18% GST in-state, free shipping over ₹2000.
    const order = await paidOrder(storeId, [{ variantId: a.id, quantity: 2 }, { variantId: b.id, quantity: 1 }]);
    expect(order).toMatchObject({ financialStatus: "paid", fulfillmentStatus: "unfulfilled", total: 299_700 + 53_946, amountPaid: 353_646 });
    expect(await level(a.id, main)).toEqual({ available: 3, committed: 2 });
    expect(await level(b.id, main)).toEqual({ available: 4, committed: 1 });
    const [lineA, lineB] = await linesOf(order.id);

    // 1) One A by courier with an AWB: tracking link filled in from the courier.
    const f1 = await createFulfillment(deps, ACTOR, storeId, order.id, { method: "courier", carrier: "delhivery", trackingNumber: "DL12345", lines: [{ orderLineId: lineA!.id, quantity: 1 }] });
    expect(f1.trackingUrl).toBe("https://www.delhivery.com/track/package/DL12345");
    expect((await orderRow(deps, order.id)).fulfillmentStatus).toBe("partially_fulfilled");
    expect(await level(a.id, main)).toEqual({ available: 3, committed: 1 });
    await expect(createFulfillment(deps, ACTOR, storeId, order.id, { method: "courier", carrier: "delhivery", trackingNumber: "x", lines: [] })).rejects.toThrow(/AWB/);

    // 2) The rest: A from the main location, B shipped from the warehouse by a local driver.
    await createFulfillment(deps, ACTOR, storeId, order.id, { method: "local_driver", driverName: "Ravi", driverMobile: "+91 98450 12345", tripLink: "https://rapido.test/trip/9", lines: [{ orderLineId: lineA!.id, quantity: 1 }] });
    const f3 = await createFulfillment(deps, ACTOR, storeId, order.id, { method: "local_driver", driverName: "Ravi", driverMobile: "9845012345", locationId: warehouse.id, lines: [{ orderLineId: lineB!.id, quantity: 1 }] });
    expect(f3.driverMobile).toBe("9845012345");
    expect((await orderRow(deps, order.id)).fulfillmentStatus).toBe("fulfilled");
    expect(await level(a.id, main)).toEqual({ available: 3, committed: 0 });
    // B's reservation at the main location was released; the warehouse unit left.
    expect(await level(b.id, main)).toEqual({ available: 5, committed: 0 });
    expect(await level(b.id, warehouse.id)).toEqual({ available: 3, committed: 0 });
    await expect(createFulfillment(deps, ACTOR, storeId, order.id, { method: "none" })).rejects.toThrow(/Nothing left/);

    const wa = await whatsappDeliveryLink(deps, ACTOR, storeId, order.id, f3.id);
    expect(wa.url).toMatch(/^https:\/\/wa\.me\/919876543210\?text=/);
    expect(wa.text).toContain("Driver: Ravi");
    expect(wa.text).toContain("Driver's number: +91 9845012345");

    // 3) Partial refund of one A with restock: line amount + its GST share.
    const calc = await calculateRefund(deps.db, storeId, order.id, { lines: [{ orderLineId: lineA!.id, quantity: 1, restock: true }] });
    expect(calc).toMatchObject({ subtotal: 99_900, tax: 17_982, shipping: 0, suggested: 117_882 });
    const r1 = await refundOrder(deps, ACTOR, storeId, order.id, { lines: [{ orderLineId: lineA!.id, quantity: 1, restock: true, locationId: main }], reason: "Damaged in transit" });
    expect(r1).toMatchObject({ status: "success", amount: 117_882 });
    let o = await orderRow(deps, order.id);
    expect(o).toMatchObject({ financialStatus: "partially_refunded", amountRefunded: 117_882, fulfillmentStatus: "fulfilled" });
    expect(await level(a.id, main)).toEqual({ available: 4, committed: 0 });
    expect(fakepayState.refunds.at(-1)).toMatchObject({ amount: 117_882, key: r1.refundId });

    // 4) Customer returns the other A and the B; staff approve, receive (restock to the warehouse) and refund.
    const returnable = await returnableQuantities(deps.db, order.id);
    expect([returnable.get(lineA!.id), returnable.get(lineB!.id)]).toEqual([1, 1]);
    const returnId = await requestReturn(deps, { type: "customer", customerId: o.customerId }, storeId, order.id, {
      lines: [
        { orderLineId: lineA!.id, quantity: 1, reason: "size" },
        { orderLineId: lineB!.id, quantity: 1, reason: "unwanted" },
      ],
      note: "Too small",
    });
    await expect(requestReturn(deps, { type: "customer" }, storeId, order.id, { lines: [{ orderLineId: lineA!.id, quantity: 1 }] })).rejects.toThrow(/can't be returned/);
    await approveReturn(deps, ACTOR, storeId, returnId);
    await receiveReturn(deps, ACTOR, storeId, returnId, { locationId: warehouse.id });
    o = await orderRow(deps, order.id);
    expect(o.fulfillmentStatus).toBe("returned");
    expect(await level(a.id, warehouse.id)).toEqual({ available: 1, committed: 0 });
    expect(await level(b.id, warehouse.id)).toEqual({ available: 4, committed: 0 });

    const resolved = await resolveReturn(deps, ACTOR, storeId, returnId, { resolution: "refund" });
    o = await orderRow(deps, order.id);
    expect(o).toMatchObject({ financialStatus: "refunded", amountRefunded: 353_646 });
    const [ret] = await deps.db.select().from(returns).where(eq(returns.id, returnId));
    expect(ret).toMatchObject({ status: "closed", resolution: "refund", refundId: resolved.refundId });
    // Stock was put back at receipt, not again at refund.
    expect(await level(a.id, warehouse.id)).toEqual({ available: 1, committed: 0 });
    const lines = await linesOf(order.id);
    expect(lines.map((l) => [l.fulfilledQuantity, l.refundedQuantity, l.returnedQuantity, l.restockedQuantity])).toEqual([
      [2, 2, 2, 2],
      [1, 1, 1, 1],
    ]);
  });

  it("refunds unfulfilled units by releasing the reservation, and the order then counts as fulfilled", async () => {
    const { storeId, variants } = await commerceStore(deps);
    const order = await paidOrder(storeId, [{ variantId: variants[0]!.id, quantity: 3 }]);
    const [line] = await linesOf(order.id);
    await createFulfillment(deps, ACTOR, storeId, order.id, { method: "pickup", lines: [{ orderLineId: line!.id, quantity: 2 }] });
    expect((await orderRow(deps, order.id)).fulfillmentStatus).toBe("partially_fulfilled");
    await refundOrder(deps, ACTOR, storeId, order.id, { lines: [{ orderLineId: line!.id, quantity: 1, restock: true }] });
    expect((await orderRow(deps, order.id)).fulfillmentStatus).toBe("fulfilled");
    expect(await level(variants[0]!.id)).toEqual({ available: 3, committed: 0 });
  });

  it("cancelling a fulfillment reserves the stock again", async () => {
    const { storeId, variants } = await commerceStore(deps);
    const order = await paidOrder(storeId, [{ variantId: variants[0]!.id, quantity: 2 }]);
    const f = await createFulfillment(deps, ACTOR, storeId, order.id, { method: "other_courier", carrier: "Speedy Couriers", trackingNumber: "SC-0099", trackingUrl: "https://speedy.test/SC-0099" });
    expect(await level(variants[0]!.id)).toEqual({ available: 3, committed: 0 });
    await cancelFulfillment(deps, ACTOR, storeId, order.id, f.id);
    expect(await level(variants[0]!.id)).toEqual({ available: 3, committed: 2 });
    expect((await orderRow(deps, order.id)).fulfillmentStatus).toBe("unfulfilled");
    expect((await listFulfillments(deps.db, order.id))[0]!.status).toBe("cancelled");
  });

  it("a pending provider refund only counts once the webhook confirms it", async () => {
    const { storeId, variants } = await commerceStore(deps);
    const order = await paidOrder(storeId, [{ variantId: variants[0]!.id, quantity: 1 }]);
    fakepayState.refundStatus = "pending";
    const r = await refundOrder(deps, ACTOR, storeId, order.id, { amount: 20_000, reason: "Goodwill" });
    expect(r.status).toBe("pending");
    expect(await orderRow(deps, order.id)).toMatchObject({ amountRefunded: 0, financialStatus: "paid" });
    // Pending refunds still reduce what can be refunded.
    expect((await calculateRefund(deps.db, storeId, order.id, {})).refundable).toBe(order.total - 20_000);

    const hook = refundWebhook("fp_refund_1", 20_000);
    expect((await handlePaymentWebhook(deps, "fakepay", hook.body, hook.headers)).outcome).toBe("applied");
    expect((await handlePaymentWebhook(deps, "fakepay", hook.body, hook.headers)).outcome).toBe("duplicate");
    expect(await orderRow(deps, order.id)).toMatchObject({ amountRefunded: 20_000, financialStatus: "partially_refunded" });
    const [row] = await deps.db.select().from(refunds).where(eq(refunds.orderId, order.id));
    expect(row!.status).toBe("success");

    fakepayState.refundStatus = "pending";
    await refundOrder(deps, ACTOR, storeId, order.id, { amount: 1_000 });
    const failed = refundWebhook("fp_refund_2", 1_000, "refund.failed");
    await handlePaymentWebhook(deps, "fakepay", failed.body, failed.headers);
    expect((await orderRow(deps, order.id)).amountRefunded).toBe(20_000);
    expect(await deps.db.select({ s: transactions.status }).from(transactions).where(and(eq(transactions.orderId, order.id), eq(transactions.kind, "refund")))).toEqual(
      expect.arrayContaining([{ s: "success" }, { s: "failure" }]),
    );
  });

  it("refunds shipping on request and never more than was paid", async () => {
    const { storeId, variants } = await commerceStore(deps);
    const order = await paidOrder(storeId, [{ variantId: variants[0]!.id, quantity: 1 }]); // ₹50 shipping
    const calc = await calculateRefund(deps.db, storeId, order.id, { fullShipping: true });
    expect(calc.shipping).toBe(5_000);
    await refundOrder(deps, ACTOR, storeId, order.id, { fullShipping: true });
    expect((await calculateRefund(deps.db, storeId, order.id, { fullShipping: true })).shipping).toBe(0);
    await expect(refundOrder(deps, ACTOR, storeId, order.id, { amount: order.total })).rejects.toThrow(/at most/);
  });

  it("exchanges create a draft order credited with the returned value", async () => {
    const { storeId, variants } = await commerceStore(deps);
    const order = await paidOrder(storeId, [{ variantId: variants[0]!.id, quantity: 1 }]);
    const [line] = await linesOf(order.id);
    await createFulfillment(deps, ACTOR, storeId, order.id, { method: "pickup" });
    const id = await requestReturn(deps, { type: "staff", actor: ACTOR }, storeId, order.id, { lines: [{ orderLineId: line!.id, quantity: 1, reason: "size" }], approve: true });
    await receiveReturn(deps, ACTOR, storeId, id);
    const { draftId } = await resolveReturn(deps, ACTOR, storeId, id, { resolution: "exchange", lines: [{ variantId: variants[2]!.id, quantity: 1 }] });
    expect(draftId).toBeTruthy();
    const { getDraft } = await import("../src/commerce/drafts.js");
    const draft = await getDraft(deps, storeId, draftId!);
    expect(draft.discount).toMatchObject({ kind: "fixed_amount", value: 99_900 + 17_982 });
  });
});

describe("shipping zones and rates", () => {
  it("picks the most specific zone (PIN prefix > state > country > rest of world) and its rates", async () => {
    const { storeId, variants } = await commerceStore(deps);
    const india = await saveZone(deps, ACTOR, storeId, { name: "India", countries: [{ country: "IN" }] });
    const blr = await saveZone(deps, ACTOR, storeId, { name: "Bengaluru", countries: [{ country: "IN", provinces: ["Karnataka"], postalPrefixes: ["560"] }] });
    const world = await saveZone(deps, ACTOR, storeId, { name: "World", countries: [{ country: "*" }] });
    await saveRate(deps, ACTOR, storeId, { zoneId: india, name: "Standard", kind: "flat", amount: 8_000, freeOver: 500_000 });
    await saveRate(deps, ACTOR, storeId, { zoneId: india, name: "Light parcel", kind: "weight", amount: 4_000, minValue: 0, maxValue: 500 });
    await saveRate(deps, ACTOR, storeId, { zoneId: india, name: "Heavy parcel", kind: "weight", amount: 9_000, minValue: 500 });
    await saveRate(deps, ACTOR, storeId, { zoneId: blr, name: "City courier", kind: "flat", amount: 3_000, freeOver: 150_000 });
    await saveRate(deps, ACTOR, storeId, { zoneId: blr, name: "Big order", kind: "price", amount: 0, minValue: 300_000 });
    await saveRate(deps, ACTOR, storeId, { zoneId: world, name: "International", kind: "flat", amount: 250_000 });
    await saveRate(deps, ACTOR, storeId, { name: "Same-day (Indiranagar)", kind: "local_delivery", amount: 2_000, postalPrefixes: ["560038"] });
    const [loc] = await deps.db.select({ locationId: inventoryLevels.locationId }).from(inventoryLevels).limit(1);
    await saveRate(deps, ACTOR, storeId, { name: "Pick up at the studio", kind: "local_pickup", amount: 0, locationId: loc!.locationId });

    const v = variants[0]!; // 200 g, ₹999
    const titles = async (address: typeof ADDRESS, quantity = 1) =>
      (await priceLines(deps.db, storeId, { lines: [{ variantId: v.id, quantity }], shippingAddress: address })).shippingRates.map((r) => `${r.title}:${r.amount}`);

    expect(await titles(ADDRESS)).toEqual(["Pick up at the studio:0", "City courier:3000"]);
    expect(await titles({ ...ADDRESS, postalCode: "560038" })).toEqual(["Same-day (Indiranagar):2000", "Pick up at the studio:0", "City courier:3000"]);
    expect(await titles(ADDRESS, 2)).toEqual(["Pick up at the studio:0", "City courier:0"]); // free over ₹1500
    expect(await titles({ ...ADDRESS, province: "Maharashtra", postalCode: "400001" })).toEqual(["Pick up at the studio:0", "Standard:8000", "Light parcel:4000"]);
    expect(await titles({ ...ADDRESS, province: "Maharashtra", postalCode: "400001" }, 3)).toEqual(["Pick up at the studio:0", "Standard:8000", "Heavy parcel:9000"]); // 600 g
    expect(await titles({ ...ADDRESS, country: "US", province: "CA", postalCode: "94105" })).toEqual(["Pick up at the studio:0", "International:250000"]);

    const chosen = await priceLines(deps.db, storeId, { lines: [{ variantId: v.id, quantity: 1 }], shippingAddress: ADDRESS, shippingRateId: (await priceLines(deps.db, storeId, { lines: [{ variantId: v.id, quantity: 1 }], shippingAddress: ADDRESS })).shippingRates[1]!.id });
    expect(chosen.shippingLine).toMatchObject({ title: "City courier", amount: 3_000 });
    expect(chosen.shippingTotal).toBe(3_000);
  });

  it("quotes carrier rates live and books the shipment and label at fulfillment; tracking webhooks move the status", async () => {
    const { storeId, variants } = await commerceStore(deps);
    shipped.length = 0;
    await upsertCredential(deps, ACTOR, { storeId, kind: "shipping", provider: "fakeship", mode: "live" }, { config: {}, secrets: { token: "ship-hook-token" } });
    const zone = await saveZone(deps, ACTOR, storeId, { name: "India", countries: [{ country: "IN" }] });
    await saveRate(deps, ACTOR, storeId, { zoneId: zone, name: "FakeShip", kind: "carrier", provider: "fakeship", amount: 1_000 });
    const priced = await priceLines(deps.db, storeId, { lines: [{ variantId: variants[0]!.id, quantity: 1 }], shippingAddress: ADDRESS }, { deps });
    expect(priced.shippingRates).toEqual([expect.objectContaining({ title: "FakeShip", amount: 7_000, kind: "carrier", carrierRateId: "fs-eco" })]);

    const order = await paidOrder(storeId, [{ variantId: variants[0]!.id, quantity: 1 }]);
    expect(order.shippingLine).toMatchObject({ amount: 7_000, carrierRateId: "fs-eco", provider: "fakeship" });
    const f = await createFulfillment(deps, ACTOR, storeId, order.id, { method: "carrier", provider: "fakeship" });
    expect(f).toMatchObject({ trackingNumber: "FS1001", trackingUrl: "https://fakeship.test/t/FS1001", labelUrl: "https://fakeship.test/label.pdf", status: "shipped" });
    expect(shipped[0]).toMatchObject({ rateId: "fs-eco", weight: 200 });

    const body = Buffer.from(JSON.stringify([{ id: "e1", awb: "FS1001", state: "out_for_delivery", description: "With the rider", at: "2026-11-20T09:00:00Z" }]));
    expect(await handleShippingWebhook(deps, storeId, "fakeship", body, { "x-token": "ship-hook-token" })).toEqual({ received: 1, applied: 1 });
    expect(await handleShippingWebhook(deps, storeId, "fakeship", body, { "x-token": "ship-hook-token" })).toEqual({ received: 1, applied: 0 });
    await expect(handleShippingWebhook(deps, storeId, "fakeship", body, { "x-token": "nope" })).rejects.toThrow(/signature/);
    const delivered = Buffer.from(JSON.stringify([{ id: "e2", awb: "FS1001", state: "delivered", description: "Delivered", at: "2026-11-20T12:00:00Z" }]));
    await handleShippingWebhook(deps, storeId, "fakeship", delivered, { "x-token": "ship-hook-token" });
    const [after] = await listFulfillments(deps.db, order.id);
    expect(after).toMatchObject({ status: "delivered", deliveredAt: "2026-11-20T12:00:00.000Z" });
    await updateFulfillmentTracking(deps, ACTOR, storeId, order.id, f.id, { trackingUrl: "https://fakeship.test/x" });
  });

  it("falls back to the setup flat rate when no zones exist", async () => {
    const { storeId, variants } = await commerceStore(deps);
    const p = await priceLines(deps.db, storeId, { lines: [{ variantId: variants[0]!.id, quantity: 1 }], shippingAddress: ADDRESS });
    expect(p.shippingRates).toEqual([expect.objectContaining({ id: "standard", amount: 5_000 })]);
  });
});

describe("discounts in pricing", () => {
  it("combines an automatic discount with a code, enforces per-customer limits and tag eligibility", async () => {
    const { storeId, variants, productId } = await commerceStore(deps);
    const tees = await createCollection(deps, ACTOR, storeId, { title: "Tees", type: "manual", productIds: [productId] } as never);
    await saveDiscount(deps, ACTOR, storeId, { title: "Tee week", method: "automatic", kind: "percentage", value: 1000, target: "collections", collectionIds: [tees.id], combinesWith: { product: false, order: true, shipping: true } });
    await saveDiscount(deps, ACTOR, storeId, { title: "₹100 off", code: "HUNDRED", kind: "fixed_amount", value: 10_000, combinesWith: { product: true, order: false, shipping: false }, usageLimitPerCustomer: 1 });
    await saveDiscount(deps, ACTOR, storeId, { title: "VIP ship", code: "VIPSHIP", kind: "free_shipping", eligibility: "tags", customerTags: ["vip"], combinesWith: { product: true, order: true, shipping: false } });

    const p = await priceLines(deps.db, storeId, { lines: [{ variantId: variants[0]!.id, quantity: 1 }], discountCode: "hundred", shippingAddress: ADDRESS, customer: { email: "asha@example.com" } });
    expect(p.discounts.map((d) => [d.title, d.amount])).toEqual([
      ["Tee week", 9_990],
      ["₹100 off", 10_000],
    ]);
    expect(p.discount).toMatchObject({ code: "HUNDRED", applied: true });
    expect(p.discountTotal).toBe(19_990);

    const vip = await priceLines(deps.db, storeId, { lines: [{ variantId: variants[0]!.id, quantity: 1 }], discountCode: "VIPSHIP", shippingAddress: ADDRESS, customer: { email: "x@example.com" } });
    expect(vip.discount.error).toMatch(/isn't available/);

    // Use HUNDRED once, then it is refused for the same customer.
    const order = await (async () => {
      const { cart, token } = await getOrCreateCart(deps, storeId, undefined);
      await addCartLines(deps, storeId, cart, { lines: [{ variantId: variants[0]!.id, quantity: 1 }] });
      await updateCart(deps, cart, { discountCode: "HUNDRED" });
      const checkout = await startCheckout(deps, storeId, cart);
      await updateCheckout(deps, storeId, checkout, cart, { email: "asha@example.com", shippingAddress: ADDRESS, paymentProvider: "fakepay" });
      const s = await createPaymentSession(deps, storeId, checkout.id, token);
      const hook = pay(String(s.clientPayload.orderId)).webhook();
      await handlePaymentWebhook(deps, "fakepay", hook.body, hook.headers);
      return orderRow(deps, s.orderId);
    })();
    expect(order.discountApplications.map((d) => d.title)).toEqual(["Tee week", "₹100 off"]);
    const again = await priceLines(deps.db, storeId, { lines: [{ variantId: variants[0]!.id, quantity: 1 }], discountCode: "HUNDRED", customer: { email: "asha@example.com" } });
    expect(again.discount.error).toMatch(/once per customer/);
  });
});

describe("gift cards", () => {
  it("pays a whole order with a gift card, keeps a ledger, and credits back an abandoned checkout", async () => {
    const { storeId, variants } = await commerceStore(deps);
    const card = await issueGiftCard(deps, ACTOR, storeId, { value: 500_000, recipientEmail: "asha@example.com", notify: false });
    expect(card.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);

    // Abandoned attempt: partially covered, then the reservation expires.
    const one = await getOrCreateCart(deps, storeId, undefined);
    await addCartLines(deps, storeId, one.cart, { lines: [{ variantId: variants[0]!.id, quantity: 5 }] });
    await updateCart(deps, one.cart, { giftCardCodes: [card.code.toLowerCase()] });
    const co1 = await startCheckout(deps, storeId, one.cart);
    await updateCheckout(deps, storeId, co1, one.cart, { email: "asha@example.com", shippingAddress: ADDRESS, paymentProvider: "fakepay" });
    const s1 = await createPaymentSession(deps, storeId, co1.id, one.token);
    expect(fakepayState.sessions.at(-1)!.amount).toBe(499_500 + 89_910 - 500_000);
    expect((await getGiftCard(deps.db, storeId, card.id)).balance).toBe(0);
    await deps.db.update(orders).set({ reservationExpiresAt: new Date(Date.now() - 1000) }).where(eq(orders.id, s1.orderId));
    await releaseExpiredReservation(deps, storeId, s1.orderId);
    expect((await getGiftCard(deps.db, storeId, card.id)).balance).toBe(500_000);

    // Fully covered: placed and paid with no payment provider.
    const two = await getOrCreateCart(deps, storeId, undefined);
    await addCartLines(deps, storeId, two.cart, { lines: [{ variantId: variants[0]!.id, quantity: 2 }] });
    await updateCart(deps, two.cart, { giftCardCodes: [card.code] });
    const co2 = await startCheckout(deps, storeId, two.cart);
    await updateCheckout(deps, storeId, co2, two.cart, { email: "asha@example.com", shippingAddress: ADDRESS });
    const s2 = await createPaymentSession(deps, storeId, co2.id, two.token);
    expect(s2).toMatchObject({ flow: "offline", provider: "gift_card" });
    const paid = await orderRow(deps, s2.orderId);
    expect(paid).toMatchObject({ financialStatus: "paid", giftCardTotal: paid.total, amountPaid: paid.total });
    const g = await getGiftCard(deps.db, storeId, card.id);
    expect(g.balance).toBe(500_000 - paid.total);
    expect(g.transactions.map((t) => t.kind)).toEqual(["issue", "redeem", "reverse", "redeem"]);

    // Refund goes back onto the card.
    await refundOrder(deps, ACTOR, storeId, paid.id, { amount: 10_000 });
    expect((await getGiftCard(deps.db, storeId, card.id)).balance).toBe(500_000 - paid.total + 10_000);
  });

  it("sells gift cards as a product and issues one card per unit once paid", async () => {
    const { storeId } = await commerceStore(deps);
    const { createProduct } = await import("../src/catalog/products.js");
    const product = await createProduct(deps, ACTOR, storeId, { title: "Gift card", status: "active", options: [], variants: [{ options: [], price: 100_000, requiresShipping: false }] } as never);
    await deps.db.execute(`update products set gift_card = true where id = '${product.id}'`);
    await deps.db.execute(`update inventory_items set tracked = false where variant_id in (select id from product_variants where product_id = '${product.id}')`);
    const [variant] = await deps.db.select().from((await import("@shopkit/db")).productVariants).where(eq((await import("@shopkit/db")).productVariants.productId, product.id));
    const order = await paidOrder(storeId, [{ variantId: variant!.id, quantity: 2 }]);
    expect(order).toMatchObject({ taxTotal: 0, shippingTotal: 0, total: 200_000 });
    const cards = await deps.db.select().from(giftCards).where(eq(giftCards.orderId, order.id));
    expect(cards.map((c) => c.initialValue)).toEqual([100_000, 100_000]);
    expect(await deps.db.select().from(giftCardTransactions).where(eq(giftCardTransactions.kind, "issue"))).toHaveLength(2);
  });
});

describe("tax and GST invoices", () => {
  const check = (inv: Awaited<ReturnType<typeof getInvoice>>) => {
    const sum = (k: "cgst" | "sgst" | "igst" | "taxableValue" | "total") => inv.lines.reduce((s, l) => s + l[k], 0);
    expect(inv.totals.cgst).toBe(sum("cgst"));
    expect(inv.totals.sgst).toBe(sum("sgst"));
    expect(inv.totals.igst).toBe(sum("igst"));
    expect(inv.totals.taxableValue).toBe(sum("taxableValue"));
    expect(sum("total")).toBe(inv.totals.total);
  };

  it("intra-state: CGST + SGST per line, totals equal the line splits; HSN and GSTINs printed", async () => {
    const { storeId, variants, productId } = await commerceStore(deps);
    await setSetting(deps.db, storeId, "tax.config", { mode: "india_gst", pricesIncludeTax: false, defaultRateBps: 1800, registeredState: "Karnataka", gstin: "29ABCDE1234F1Z5", taxShipping: true });
    // Apparel at 5% via a collection override; the M tee is outside it.
    const apparel = await createCollection(deps, ACTOR, storeId, { title: "Apparel", type: "manual", productIds: [productId] } as never);
    await saveTaxOverride(deps, ACTOR, storeId, { collectionId: apparel.id, country: "IN", rateBps: 500 });
    const order = await paidOrder(storeId, [{ variantId: variants[0]!.id, quantity: 1 }, { variantId: variants[3]!.id, quantity: 1 }]);
    const inv = await getInvoice(deps, storeId, order.id);
    expect(inv).toMatchObject({ number: "INV-00001", intraState: true, seller: { taxId: "29ABCDE1234F1Z5" } });
    expect(inv.lines.map((l) => [l.hsn, l.rateBps, l.cgst, l.sgst, l.igst])).toEqual([
      ["6109", 500, 2497, 2498, 0],
      ["6109", 500, 2747, 2748, 0],
    ]);
    check(inv);
    expect(inv.totals.cgst + inv.totals.sgst).toBe(order.taxTotal);
    expect(inv.totals.total).toBe(order.total);
    // Issued once: the same number on reprint.
    expect((await getInvoice(deps, storeId, order.id)).number).toBe("INV-00001");
    const pdf = renderInvoicePdf(inv);
    expect(pdf.subarray(0, 8).toString("latin1")).toBe("%PDF-1.4");
    expect(pdf.toString("latin1")).toContain("(TAX INVOICE)");
    expect(pdf.toString("latin1")).toMatch(/startxref\n\d+\n%%EOF\n$/);
  });

  it("inter-state: IGST only, with taxed shipping as its own line; tax-inclusive prices split back out", async () => {
    const { storeId, variants } = await commerceStore(deps);
    await setSetting(deps.db, storeId, "tax.config", { mode: "india_gst", pricesIncludeTax: true, defaultRateBps: 1800, registeredState: "Karnataka", gstin: "29ABCDE1234F1Z5", taxShipping: true });
    const mumbai = { ...ADDRESS, city: "Mumbai", province: "Maharashtra", postalCode: "400001" };
    const order = await paidOrder(storeId, [{ variantId: variants[0]!.id, quantity: 1 }], mumbai);
    const inv = await getInvoice(deps, storeId, order.id);
    expect(inv.intraState).toBe(false);
    expect(inv.placeOfSupply).toBe("Maharashtra");
    expect(inv.lines.map((l) => [l.description.startsWith("Shipping") ? "ship" : "item", l.taxableValue, l.igst, l.cgst])).toEqual([
      ["item", 84_661, 15_239, 0],
      ["ship", 4_237, 763, 0],
    ]);
    check(inv);
    expect(inv.totals.igst).toBe(order.taxTotal);
    expect(inv.totals.total).toBe(99_900 + 5_000);
    expect(inv.amountInWords).toBe("Rupees One Thousand Forty Nine Only");
  });

  it("generic VAT by country and region; GST exports are zero-rated", async () => {
    const { storeId, variants } = await commerceStore(deps);
    await setSetting(deps.db, storeId, "tax.config", { mode: "generic", pricesIncludeTax: false, defaultRateBps: 0, label: "VAT" });
    await saveTaxRate(deps, ACTOR, storeId, { country: "GB", name: "VAT", rateBps: 2000 });
    await saveTaxRate(deps, ACTOR, storeId, { country: "US", province: "CA", name: "CA sales tax", rateBps: 725 });
    const at = (country: string, province: string | null) => priceLines(deps.db, storeId, { lines: [{ variantId: variants[0]!.id, quantity: 1 }], shippingAddress: { ...ADDRESS, country, province } });
    expect((await at("GB", "London")).taxLines).toEqual([{ title: "VAT", rateBps: 2000, amount: 19_980 }]);
    expect((await at("US", "CA")).taxLines).toEqual([{ title: "CA sales tax", rateBps: 725, amount: 7_243 }]);
    expect((await at("US", "OR")).taxTotal).toBe(0);
    await setSetting(deps.db, storeId, "tax.config", { mode: "india_gst", pricesIncludeTax: false, defaultRateBps: 1800, registeredState: "Karnataka" });
    expect((await at("US", "CA")).taxTotal).toBe(0);
  });

  it("writes amounts in Indian words", () => {
    expect(indianWords(12_34_56_789)).toBe("Twelve Crore Thirty Four Lakh Fifty Six Thousand Seven Hundred Eighty Nine");
    expect(rupeesInWords(353_646)).toBe("Rupees Three Thousand Five Hundred Thirty Six and Forty Six Paise Only");
  });
});
