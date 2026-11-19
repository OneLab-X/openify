import { beginSetup, launchStore, orderStatusToken, saveOwnerStep, saveStorageStep, saveStoreStep } from "@shopkit/core";
import { eq, outboxEvents } from "@shopkit/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Jar, makeHarness, STRONG, type Harness } from "./harness.js";

let h: Harness;
let storeId: string;
beforeAll(async () => {
  h = await makeHarness();
});
afterAll(() => h.close());

beforeEach(async () => {
  await h.reset();
  storeId = await beginSetup(h.deps);
  const actor = { type: "setup" as const };
  await saveOwnerStep(h.deps, actor, { name: "Asha", email: "asha@pls.test", password: STRONG });
  await saveStorageStep(h.deps, actor, { provider: "local", mode: "live" });
  await saveStoreStep(h.deps, actor, {
    name: "PLS", email: "hello@pls.test", country: "IN", currency: "INR", timezone: "UTC", locale: "en-IN", weightUnit: "kg", publicUrl: "https://shop.test",
  });
  await launchStore(h.deps, actor);
});

type Call = (method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: unknown) => ReturnType<Harness["app"]["inject"]>;

async function signIn(email = "asha@pls.test", password = STRONG): Promise<Call> {
  const jar = new Jar();
  const res = jar.absorb(await h.app.inject({ method: "POST", url: "/api/admin/auth/login", payload: { email, password } }));
  expect(res.statusCode).toBe(200);
  const csrf = res.json<{ csrf: string }>().csrf;
  return (method, url, payload) => h.app.inject({ method, url, payload: payload as never, headers: { cookie: jar.header, "x-csrf-token": csrf } });
}

const ADDRESS = { firstName: "Asha", lastName: "K", line1: "1 MG Road", city: "Bengaluru", province: "Karnataka", postalCode: "560001", country: "IN", phone: "+91 98765 43210" };

/** A paid order with two units of one product, placed through a draft. */
async function paidOrder(admin: Call) {
  const p = await admin("POST", "/api/admin/products", { title: "Kurta", status: "active", variants: [{ options: [], price: 100_000, inventory: [{ available: 5 }] }] });
  expect(p.statusCode).toBe(200);
  const variantId = p.json<{ variants: { id: string }[] }>().variants[0]!.id;
  const draft = await admin("POST", "/api/admin/draft-orders", { email: "buyer@example.com", shippingAddress: ADDRESS, lines: [{ variantId, quantity: 2 }] });
  expect(draft.statusCode).toBe(200);
  const done = await admin("POST", `/api/admin/draft-orders/${draft.json<{ id: string }>().id}/complete`, { paymentPending: true });
  const orderId = done.json<{ orderId: string }>().orderId;
  expect((await admin("POST", `/api/admin/orders/${orderId}/mark-paid`, {})).json()).toMatchObject({ financialStatus: "paid" });
  return { orderId, variantId };
}

describe("Phase 4 admin API", () => {
  it("fulfils in parts, tracks, prints the invoice, refunds and handles a customer-requested return", async () => {
    const admin = await signIn();
    const { orderId } = await paidOrder(admin);
    const order0 = (await admin("GET", `/api/admin/orders/${orderId}`)).json<{ lines: { id: string; fulfillableQuantity: number }[] }>();
    const lineId = order0.lines[0]!.id;
    expect(order0.lines[0]!.fulfillableQuantity).toBe(2);

    const couriers = await admin("GET", "/api/admin/couriers");
    expect(couriers.json<{ couriers: { id: string }[] }>().couriers.map((c) => c.id)).toContain("delhivery");

    const bad = await admin("POST", `/api/admin/orders/${orderId}/fulfillments`, { method: "courier", carrier: "delhivery", trackingNumber: "x" });
    expect(bad.statusCode).toBe(422);
    const one = await admin("POST", `/api/admin/orders/${orderId}/fulfillments`, { method: "courier", carrier: "delhivery", trackingNumber: "AWB12345", lines: [{ orderLineId: lineId, quantity: 1 }] });
    expect(one.statusCode).toBe(200);
    expect(one.json()).toMatchObject({ fulfillmentStatus: "partially_fulfilled", fulfillments: [{ carrierName: "Delhivery", trackingUrl: expect.stringContaining("AWB12345") }] });

    const two = await admin("POST", `/api/admin/orders/${orderId}/fulfillments`, { method: "local_driver", driverName: "Ravi", driverMobile: "09876543210" });
    expect(two.json()).toMatchObject({ fulfillmentStatus: "fulfilled" });
    const local = two.json<{ fulfillments: { id: string; method: string }[] }>().fulfillments.find((f) => f.method === "local_driver")!;
    const wa = await admin("POST", `/api/admin/orders/${orderId}/fulfillments/${local.id}/whatsapp`);
    expect(wa.json<{ url: string }>().url).toMatch(/^https:\/\/wa\.me\/919876543210\?text=/);
    const delivered = await admin("PATCH", `/api/admin/orders/${orderId}/fulfillments/${local.id}`, { status: "delivered" });
    expect(delivered.json<{ fulfillments: { id: string; status: string }[] }>().fulfillments.find((f) => f.id === local.id)!.status).toBe("delivered");

    const pdf = await admin("GET", `/api/admin/orders/${orderId}/invoice.pdf`);
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers["content-type"]).toBe("application/pdf");
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe("%PDF-");

    const calc = await admin("POST", `/api/admin/orders/${orderId}/refunds/calculate`, { lines: [{ orderLineId: lineId, quantity: 1, restock: false }] });
    expect(calc.json()).toMatchObject({ refundable: 200_000 });

    // The shopper asks for a return of one unit from the status page.
    const token = orderStatusToken(h.deps, orderId);
    const asked = await h.app.inject({
      method: "POST",
      url: `/api/storefront/orders/${token}/returns`,
      payload: { lines: [{ orderLineId: lineId, quantity: 1, reason: "size" }], note: "Too small" },
      headers: { "x-shopkit-client": "storefront" },
    });
    expect(asked.statusCode).toBe(200);
    expect(asked.json()).toMatchObject({ returns: [{ status: "requested" }], returnable: { [lineId]: 1 } });
    const tooMany = await h.app.inject({
      method: "POST",
      url: `/api/storefront/orders/${token}/returns`,
      payload: { lines: [{ orderLineId: lineId, quantity: 2 }] },
      headers: { "x-shopkit-client": "storefront" },
    });
    expect(tooMany.statusCode).toBe(422);

    const list = await admin("GET", "/api/admin/returns?status=requested");
    const returnId = list.json<{ items: { id: string; requestedBy: string }[] }>().items[0]!.id;
    expect(list.json()).toMatchObject({ items: [{ requestedBy: "customer", orderId }] });
    await admin("POST", `/api/admin/returns/${returnId}/approve`, { notify: false });
    await admin("POST", `/api/admin/returns/${returnId}/receive`, {});
    const resolved = await admin("POST", `/api/admin/returns/${returnId}/resolve`, { resolution: "refund", notify: false });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json()).toMatchObject({ financialStatus: "partially_refunded", returns: [{ status: "closed", resolution: "refund" }] });
  });

  it("manages shipping zones, tax rates, gift cards and discount permissions", async () => {
    const admin = await signIn();
    const zone = await admin("POST", "/api/admin/shipping/zones", { name: "India", countries: [{ country: "IN" }] });
    expect(zone.statusCode).toBe(200);
    const zoneId = zone.json<{ zones: { id: string }[] }>().zones[0]!.id;
    const rate = await admin("POST", "/api/admin/shipping/rates", { zoneId, name: "Standard", kind: "flat", amount: 5_000, freeOver: 99_900 });
    expect(rate.json()).toMatchObject({ zones: [{ name: "India", rates: [{ name: "Standard", amount: 5_000, freeOver: 99_900 }] }] });
    expect((await admin("POST", "/api/admin/shipping/rates", { name: "Pickup", kind: "local_pickup" })).statusCode).toBe(422);

    const tax = await admin("POST", "/api/admin/tax/rates", { country: "de", name: "MwSt", rateBps: 1900 });
    expect(tax.json()).toMatchObject({ rates: [{ country: "DE", rateBps: 1900 }] });

    const issued = await admin("POST", "/api/admin/gift-cards", { value: 50_000, recipientEmail: "friend@example.com" });
    expect(issued.statusCode).toBe(200);
    const card = issued.json<{ id: string; code: string; lastCharacters: string }>();
    expect(card.code.replace(/-/g, "").slice(-4)).toBe(card.lastCharacters);
    const adjusted = await admin("PATCH", `/api/admin/gift-cards/${card.id}`, { adjustment: -10_000, adjustmentNote: "Goodwill reversal" });
    expect(adjusted.json()).toMatchObject({ balance: 40_000, transactions: [{ kind: "issue" }, { kind: "adjust", amount: -10_000 }] });
    expect((await admin("GET", `/api/admin/gift-cards?query=${card.lastCharacters}`)).json<{ items: unknown[] }>().items).toHaveLength(1);
    expect(await h.deps.db.$count(outboxEvents, eq(outboxEvents.type, "gift_card.issued"))).toBe(1);

    // A role without discounts:write can read discounts but not create them.
    const roles = await admin("POST", "/api/admin/roles", { name: "Support", permissions: ["home:read", "discounts:read"] });
    const support = roles.json<{ items: { id: string; name: string }[] }>().items.find((r) => r.name === "Support")!;
    const invites = await admin("POST", "/api/admin/invites", { email: "sam@pls.test", roleId: support.id });
    expect(invites.json()).toMatchObject({ items: [{ email: "sam@pls.test", roleName: "Support" }] });
    const [ev] = await h.deps.db.select().from(outboxEvents).where(eq(outboxEvents.type, "staff.invited"));
    const inviteToken = String((ev!.payload as { acceptUrl: string }).acceptUrl).split("/").at(-1)!;
    expect((await h.app.inject({ method: "GET", url: `/api/admin/auth/invites/${inviteToken}` })).json()).toMatchObject({ email: "sam@pls.test", storeName: "PLS", roleName: "Support" });
    expect((await h.app.inject({ method: "POST", url: `/api/admin/auth/invites/${inviteToken}/accept`, payload: { name: "Sam", password: STRONG } })).statusCode).toBe(200);
    const sam = await signIn("sam@pls.test");
    expect((await sam("GET", "/api/admin/discounts")).statusCode).toBe(200);
    expect((await sam("POST", "/api/admin/discounts", { title: "X", code: "XX10", kind: "percentage", value: 1000 })).statusCode).toBe(403);
    expect((await sam("GET", "/api/admin/dashboard")).statusCode).toBe(200);
    expect((await sam("GET", "/api/admin/reports/sales?from=2026-01-01&to=2026-01-31")).statusCode).toBe(403);
  });

  it("reports, CSV export, audit search and the enforced 2FA gate", async () => {
    const admin = await signIn();
    await paidOrder(admin);
    const today = new Date().toISOString().slice(0, 10);
    const report = await admin("GET", `/api/admin/reports/sales?from=${today}&to=${today}`);
    expect(report.statusCode).toBe(200);
    expect(report.json()).toMatchObject({ currency: "INR", current: { orders: 1, grossSales: 200_000 }, topProducts: [{ title: "Kurta", units: 2 }] });
    const csv = await admin("GET", `/api/admin/reports/export?from=${today}&to=${today}&kind=orders`);
    expect(csv.headers["content-type"]).toMatch(/^text\/csv/);
    expect(csv.body.split("\n")[0]).toMatch(/^Order,Placed at/);
    const dash = await admin("GET", "/api/admin/dashboard");
    expect(dash.json()).toMatchObject({ totals: { orders: 1, today: 1 } });

    const audit = await admin("GET", "/api/admin/audit?action=order.");
    expect(audit.statusCode).toBe(200);
    expect(audit.json<{ items: { actorName: string | null }[] }>().items.length).toBeGreaterThan(0);

    // Owner cannot require 2FA before enabling it for themself.
    expect((await admin("PUT", "/api/admin/security", { requireTwoFactor: true })).statusCode).toBe(409);

    const roles = (await admin("GET", "/api/admin/roles")).json<{ items: { id: string; key: string }[] }>().items;
    await admin("POST", "/api/admin/invites", { email: "lee@pls.test", roleId: roles.find((r) => r.key === "staff")!.id });
    const [ev] = await h.deps.db.select().from(outboxEvents).where(eq(outboxEvents.type, "staff.invited"));
    await h.app.inject({ method: "POST", url: `/api/admin/auth/invites/${String((ev!.payload as { acceptUrl: string }).acceptUrl).split("/").at(-1)}/accept`, payload: { name: "Lee", password: STRONG } });
    const { setSetting } = await import("@shopkit/core");
    await setSetting(h.deps.db, storeId, "security.config", { requireTwoFactor: true });
    const lee = await signIn("lee@pls.test");
    const blocked = await lee("GET", "/api/admin/orders");
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json()).toMatchObject({ error: { details: { reason: "two_factor_required" } } });
    expect((await lee("GET", "/api/admin/auth/me")).json()).toMatchObject({ staff: { twoFactorSetupRequired: true } });
    expect((await lee("POST", "/api/admin/auth/totp/start")).statusCode).toBe(200);
  });
});
