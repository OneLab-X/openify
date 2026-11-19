import { createHmac } from "node:crypto";
import { beginSetup, launchStore, saveOwnerStep, saveStorageStep, saveStoreStep, setSetting, upsertCredential, dispatchOutbox, routeOutboxEvent } from "@shopkit/core";
import { eq, inventoryItems, inventoryLevels, outboxEvents, productVariants, transactions } from "@shopkit/db";
import { WebhookSignatureError, type PaymentResult, type ProviderDefinition } from "@shopkit/providers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { Jar, makeHarness, STRONG, type Harness } from "./harness.js";

/** Payment provider double: the signed webhook body carries whatever amount the test chooses. */
const WEBHOOK_SECRET = "api-fake-webhook-secret";
const sessions: { amount: number; orderId: string }[] = [];
const fake: ProviderDefinition<"payment", Record<string, never>, { webhookSecret: string }> = {
  id: "apifake",
  kind: "payment",
  displayName: "API Fake",
  modes: ["test"],
  paymentFlow: "widget",
  configSchema: z.object({}),
  secretsSchema: z.object({ webhookSecret: z.string() }),
  create: (ctx) => ({
    testCredentials: () => Promise.resolve({ ok: true }),
    createSession: ({ order, amount }) => {
      sessions.push({ amount, orderId: order.id });
      return Promise.resolve({ providerOrderId: `af_${sessions.length}`, clientPayload: { provider: "apifake", amount } });
    },
    verifyReturn: () => Promise.reject(new WebhookSignatureError("returns are not used here")),
    parseWebhook: (raw, headers) => {
      const sig = createHmac("sha256", ctx.secrets.webhookSecret).update(raw).digest("hex");
      if (headers["x-apifake-signature"] !== sig) return Promise.reject(new WebhookSignatureError("bad signature"));
      const body = JSON.parse(raw.toString()) as { id: string; payment: PaymentResult };
      return Promise.resolve({ id: body.id, providerType: "captured", type: "payment.captured", payment: body.payment, refund: null, raw: body });
    },
    refund: () => Promise.reject(new Error("unused")),
    getPayment: () => Promise.reject(new Error("unused")),
  }),
};

let h: Harness;
let storeId: string;
beforeAll(async () => {
  h = await makeHarness();
  h.deps.registry.register(fake);
});
afterAll(() => h.close());

beforeEach(async () => {
  await h.reset();
  sessions.length = 0;
  storeId = await beginSetup(h.deps);
  const actor = { type: "setup" as const };
  await saveOwnerStep(h.deps, actor, { name: "Asha", email: "asha@pls.test", password: STRONG });
  await saveStorageStep(h.deps, actor, { provider: "local", mode: "live" });
  await saveStoreStep(h.deps, actor, {
    name: "PLS", email: "hello@pls.test", country: "IN", currency: "INR", timezone: "UTC", locale: "en-IN", weightUnit: "kg", publicUrl: "https://shop.test",
  });
  await launchStore(h.deps, actor);
  await setSetting(h.deps.db, storeId, "payments.mode", "test");
  await upsertCredential(h.deps, actor, { storeId, kind: "payment", provider: "apifake", mode: "test" }, { config: {}, secrets: { webhookSecret: WEBHOOK_SECRET } });
});

async function staff() {
  const jar = new Jar();
  const res = jar.absorb(await h.app.inject({ method: "POST", url: "/api/admin/auth/login", payload: { email: "asha@pls.test", password: STRONG } }));
  const csrf = res.json<{ csrf: string }>().csrf;
  return (method: "GET" | "POST" | "PUT" | "PATCH", url: string, payload?: unknown) =>
    h.app.inject({ method, url, payload: payload as never, headers: { cookie: jar.header, "x-csrf-token": csrf } });
}

/** A shopper's browser: cookie jar plus the X-Shopkit-Client header the storefront sends. */
function shopper() {
  const jar = new Jar();
  const call = async (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown, headers: Record<string, string> = { "x-shopkit-client": "storefront" }) =>
    jar.absorb(await h.app.inject({ method, url, payload: payload as never, headers: { cookie: jar.header, ...headers } }));
  return { jar, call };
}

async function product(admin: Awaited<ReturnType<typeof staff>>) {
  const res = await admin("POST", "/api/admin/products", { title: "Kurta", status: "active", variants: [{ options: [], price: 120_000, inventory: [{ available: 4 }] }] });
  expect(res.statusCode).toBe(200);
  const [v] = await h.deps.db.select().from(productVariants).where(eq(productVariants.productId, res.json<{ id: string }>().id));
  return v!;
}

const ADDRESS = { firstName: "Asha", lastName: "K", line1: "1 MG Road", city: "Bengaluru", province: "Karnataka", postalCode: "560001", country: "IN" };

describe("storefront commerce API", () => {
  it("requires the client header on cookie-authenticated writes (CSRF)", async () => {
    const admin = await staff();
    const v = await product(admin);
    const s = shopper();
    expect((await s.call("POST", "/api/storefront/cart/lines", { lines: [{ variantId: v.id }] }, {})).statusCode).toBe(403);
    const ok = await s.call("POST", "/api/storefront/cart/lines", { lines: [{ variantId: v.id, quantity: 2 }] });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers["cache-control"]).toBe("no-store");
    expect(s.jar.cookies.has("sk_cart")).toBe(true);
    expect((await s.call("GET", "/api/storefront/cart")).json()).toMatchObject({ itemCount: 2, subtotal: 240_000 });
    expect((await shopper().call("GET", "/api/storefront/cart")).json()).toMatchObject({ itemCount: 0 });
  });

  it("buys end to end: amounts in the request body are ignored and the signed webhook is idempotent", async () => {
    const admin = await staff();
    const v = await product(admin);
    const s = shopper();
    await s.call("POST", "/api/storefront/cart/lines", { lines: [{ variantId: v.id, quantity: 1 }] });
    const { checkoutId } = (await s.call("POST", "/api/storefront/checkout")).json<{ checkoutId: string }>();
    const co = await s.call("PATCH", `/api/storefront/checkouts/${checkoutId}`, { email: "buyer@example.com", shippingAddress: ADDRESS, paymentProvider: "apifake", total: 1, amount: 1 });
    expect(co.statusCode).toBe(200);
    expect(co.json()).toMatchObject({ total: 120_000, missing: [], paymentMethods: [expect.objectContaining({ id: "apifake" })] });
    expect((await shopper().call("GET", `/api/storefront/checkouts/${checkoutId}`)).statusCode).toBe(404);

    const session = await s.call("POST", `/api/storefront/checkouts/${checkoutId}/payment-session`, { amount: 1, currency: "USD" });
    expect(session.statusCode).toBe(200);
    expect(sessions).toEqual([{ amount: 120_000, orderId: session.json<{ orderId: string }>().orderId }]);

    const body = JSON.stringify({
      id: "evt_1",
      payment: { status: "captured", providerPaymentId: "pay_1", providerOrderId: "af_1", amount: 120_000, amountRefunded: 0, currency: "INR", orderReference: null },
    });
    const sig = createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex");
    const post = (signature: string) =>
      h.app.inject({ method: "POST", url: "/api/webhooks/payments/apifake", payload: body, headers: { "content-type": "application/json", "x-apifake-signature": signature } });
    expect((await post("forged")).statusCode).toBe(401);
    expect((await post(sig)).json()).toEqual({ ok: true, outcome: "applied" });
    expect((await post(sig)).json()).toEqual({ ok: true, outcome: "duplicate" });
    expect(await h.deps.db.$count(transactions)).toBe(1);

    const [level] = await h.deps.db
      .select({ available: inventoryLevels.available, committed: inventoryLevels.committed })
      .from(inventoryLevels)
      .innerJoin(inventoryItems, eq(inventoryItems.id, inventoryLevels.inventoryItemId))
      .where(eq(inventoryItems.variantId, v.id));
    expect(level).toEqual({ available: 3, committed: 1 });

    const view = (await s.call("GET", `/api/storefront/checkouts/${checkoutId}`)).json<{ status: string; orderStatusToken: string }>();
    expect(view.status).toBe("completed");
    const status = await s.call("GET", `/api/storefront/orders/${view.orderStatusToken}`);
    expect(status.json()).toMatchObject({ name: "#1001", financialStatus: "paid", total: 120_000, placed: true });
    expect((await s.call("GET", `/api/storefront/orders/${view.orderStatusToken.slice(0, -2)}xx`)).statusCode).toBe(404);

    const list = await admin("GET", "/api/admin/orders");
    expect(list.json()).toMatchObject({ items: [{ name: "#1001", email: "buyer@example.com", itemCount: 1 }] });
    const orderId = list.json<{ items: { id: string }[] }>().items[0]!.id;
    const commented = await admin("POST", `/api/admin/orders/${orderId}/comments`, { message: "Gift wrap" });
    expect(commented.json<{ events: { type: string }[] }>().events.map((e) => e.type)).toEqual(expect.arrayContaining(["comment", "placed", "payment_captured"]));
    const customers = await admin("GET", "/api/admin/customers");
    expect(customers.json()).toMatchObject({ items: [{ email: "buyer@example.com", ordersCount: 1, totalSpent: 120_000 }] });

    // One confirmation email job for the order, however many times the outbox is drained.
    const jobs: string[] = [];
    await dispatchOutbox(h.deps.db, async (events) => {
      for (const e of events) for (const j of await routeOutboxEvent(h.deps, e)) jobs.push(`${j.queue}:${j.name}`);
    });
    expect(jobs.filter((j) => j === "email:order_confirmation")).toHaveLength(1);
    expect(await h.deps.db.$count(outboxEvents, eq(outboxEvents.type, "order.placed"))).toBe(1);
  });

  it("signs customers in with an emailed code and shows their orders", async () => {
    const s = shopper();
    expect((await s.call("GET", "/api/storefront/account")).statusCode).toBe(401);
    expect((await s.call("POST", "/api/storefront/account/otp", { email: "Me@Example.com" })).statusCode).toBe(200);
    const [event] = await h.deps.db.select().from(outboxEvents).where(eq(outboxEvents.type, "customer.otp_requested"));
    const code = (event!.payload as { code: string }).code;
    expect((await s.call("POST", "/api/storefront/account/otp/verify", { email: "me@example.com", code: "000000" === code ? "111111" : "000000" })).statusCode).toBe(401);
    const login = await s.call("POST", "/api/storefront/account/otp/verify", { email: "me@example.com", code });
    expect(login.statusCode).toBe(200);
    expect(s.jar.cookies.has("sk_customer")).toBe(true);
    const added = await s.call("POST", "/api/storefront/account/addresses", ADDRESS);
    expect(added.json()).toMatchObject({ email: "me@example.com", addresses: [{ city: "Bengaluru", isDefault: true }] });
    expect((await s.call("GET", "/api/storefront/account/orders")).json()).toEqual({ items: [] });
    await s.call("POST", "/api/storefront/account/logout");
    expect((await s.call("GET", "/api/storefront/account")).statusCode).toBe(401);
  });

  it("admin discounts, drafts and notification templates", async () => {
    const admin = await staff();
    const v = await product(admin);
    expect((await admin("POST", "/api/admin/discounts", { title: "Diwali", code: "DIWALI", kind: "percentage", value: 1000 })).statusCode).toBe(200);
    expect((await admin("POST", "/api/admin/discounts", { title: "Dup", code: "diwali", kind: "percentage", value: 500 })).statusCode).toBe(409);
    const draft = await admin("POST", "/api/admin/draft-orders", { email: "phone@example.com", lines: [{ variantId: v.id, quantity: 1 }] });
    expect(draft.json()).toMatchObject({ name: "D1", total: 120_000 });
    const done = await admin("POST", `/api/admin/draft-orders/${draft.json<{ id: string }>().id}/complete`, { paymentPending: true });
    const order = await admin("GET", `/api/admin/orders/${done.json<{ orderId: string }>().orderId}`);
    expect(order.json()).toMatchObject({ sourceName: "draft", financialStatus: "pending" });
    const paid = await admin("POST", `/api/admin/orders/${done.json<{ orderId: string }>().orderId}/mark-paid`, {});
    expect(paid.json()).toMatchObject({ financialStatus: "paid" });

    const templates = await admin("GET", "/api/admin/notifications/templates");
    expect(templates.json<{ items: { id: string }[] }>().items.map((t) => t.id)).toContain("order_confirmation");
    const updated = await admin("PUT", "/api/admin/notifications/templates/order_confirmation", { subject: "Yay {{order_name}}", intro: "Thanks a lot" });
    expect(updated.json()).toMatchObject({ subject: "Yay {{order_name}}", intro: "Thanks a lot" });
    expect((await admin("PUT", "/api/admin/notifications/templates/nope", { subject: "x" })).statusCode).toBe(404);
  });
});
