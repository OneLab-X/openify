import { createHmac } from "node:crypto";
import { orders, productVariants, eq, asc, type MailingAddress } from "@shopkit/db";
import { WebhookSignatureError, type PaymentResult, type ProviderDefinition } from "@shopkit/providers";
import { z } from "zod";
import { upsertCredential } from "../src/credentials.js";
import { createProduct } from "../src/catalog/products.js";
import { setSetting } from "../src/settings.js";
import { ACTOR, type TestDeps } from "./harness.js";
import { makeStore, teeInput } from "./catalog-fixtures.js";

/**
 * In-memory payment provider for core tests. Payments are "captured" when the test calls `pay`;
 * returns are signed with the key secret and webhooks with the webhook secret, like real adapters.
 */
export const FAKEPAY_SECRET = "fakepay-key-secret";
export const FAKEPAY_WEBHOOK_SECRET = "fakepay-webhook-secret";

interface FakeOrder {
  id: string;
  amount: number;
  currency: string;
  reference: string;
  payment?: PaymentResult;
}
export const fakepayState = {
  orders: new Map<string, FakeOrder>(),
  sessions: [] as { amount: number; orderId: string }[],
  refunds: [] as { paymentId: string; amount: number; key?: string }[],
  /** What the next refund call reports (Phase 4: pending refunds settle by webhook). */
  refundStatus: "success" as "success" | "pending",
};

const sign = (s: string, secret: string) => createHmac("sha256", secret).update(s).digest("hex");

export const fakepay: ProviderDefinition<"payment", { keyId: string }, { keySecret: string; webhookSecret: string }> = {
  id: "fakepay",
  kind: "payment",
  displayName: "FakePay",
  modes: ["test", "live"],
  paymentFlow: "widget",
  configSchema: z.object({ keyId: z.string() }),
  secretsSchema: z.object({ keySecret: z.string(), webhookSecret: z.string() }),
  webhookEvents: ["payment.captured"],
  create: (ctx) => ({
    testCredentials: () => Promise.resolve({ ok: true }),
    createSession: ({ order, amount, currency }) => {
      const id = `fp_order_${fakepayState.orders.size + 1}`;
      fakepayState.orders.set(id, { id, amount, currency, reference: order.id });
      fakepayState.sessions.push({ amount, orderId: order.id });
      return Promise.resolve({ providerOrderId: id, clientPayload: { provider: "fakepay", orderId: id, amount } });
    },
    verifyReturn: (payload) => {
      const { fp_order, fp_payment, fp_signature } = payload as Record<string, string>;
      if (!fp_order || !fp_payment || fp_signature !== sign(`${fp_order}|${fp_payment}`, ctx.secrets.keySecret)) return Promise.reject(new WebhookSignatureError("bad signature"));
      const o = fakepayState.orders.get(fp_order);
      if (!o?.payment) return Promise.reject(new WebhookSignatureError("unknown payment"));
      return Promise.resolve(o.payment);
    },
    parseWebhook: (raw, headers) => {
      if (headers["x-fakepay-signature"] !== sign(raw.toString(), ctx.secrets.webhookSecret)) return Promise.reject(new WebhookSignatureError("bad webhook signature"));
      const body = JSON.parse(raw.toString()) as { id: string; type: "payment.captured" | "payment.failed" | "refund.processed"; payment: PaymentResult; refund?: { id: string; amount: number; status: string } };
      return Promise.resolve({ id: body.id, providerType: body.type, type: body.type, payment: body.payment, refund: body.refund ?? null, raw: body });
    },
    refund: (paymentId, amount, _reason, key) => {
      fakepayState.refunds.push({ paymentId, amount, ...(key ? { key } : {}) });
      return Promise.resolve({ id: `fp_refund_${fakepayState.refunds.length}`, kind: "refund", status: fakepayState.refundStatus, amount, currency: "INR" });
    },
    getPayment: () => Promise.reject(new Error("not used")),
  }),
};

/** Simulates the shopper paying: returns the signed browser return payload and a signed webhook. */
export function pay(providerOrderId: string, opts: { amount?: number; status?: "captured" | "failed" } = {}) {
  const o = fakepayState.orders.get(providerOrderId)!;
  const paymentId = `fp_pay_${providerOrderId}`;
  o.payment = {
    status: opts.status ?? "captured",
    providerPaymentId: paymentId,
    providerOrderId,
    amount: opts.amount ?? o.amount,
    amountRefunded: 0,
    currency: o.currency,
    method: "card",
    orderReference: o.reference,
    errorDescription: opts.status === "failed" ? "Card declined" : null,
  };
  const returnPayload = { fp_order: providerOrderId, fp_payment: paymentId, fp_signature: sign(`${providerOrderId}|${paymentId}`, FAKEPAY_SECRET) };
  const webhook = (eventId = `evt_${paymentId}_${o.payment!.status}`) => {
    const payment = o.payment!;
    const body = Buffer.from(JSON.stringify({ id: eventId, type: payment.status === "failed" ? "payment.failed" : "payment.captured", payment }));
    return { body, headers: { "x-fakepay-signature": sign(body.toString(), FAKEPAY_WEBHOOK_SECRET) } };
  };
  return { paymentId, returnPayload, webhook };
}

export const ADDRESS: MailingAddress = { firstName: "Asha", lastName: "Kumar", line1: "12 MG Road", city: "Bengaluru", province: "Karnataka", postalCode: "560001", country: "IN", phone: "9876543210" };

/**
 * A launched store (INR, GST 18% exclusive, registered in Karnataka, ₹50 shipping free over ₹2000),
 * FakePay in test mode plus COD, and the 6-variant tee with 5 of each variant in stock.
 */
export async function commerceStore(deps: TestDeps) {
  fakepayState.orders.clear();
  fakepayState.sessions.length = 0;
  fakepayState.refunds.length = 0;
  fakepayState.refundStatus = "success";
  const storeId = await makeStore(deps);
  await setSetting(deps.db, storeId, "tax.config", { mode: "india_gst", pricesIncludeTax: false, defaultRateBps: 1800, registeredState: "Karnataka" });
  await setSetting(deps.db, storeId, "shipping.defaults", { zoneName: "India", countries: ["IN"], rateName: "Standard", rateAmount: 5_000, freeOver: 200_000 });
  await setSetting(deps.db, storeId, "payments.mode", "test");
  await upsertCredential(deps, ACTOR, { storeId, kind: "payment", provider: "fakepay", mode: "test" }, { config: { keyId: "fp_test" }, secrets: { keySecret: FAKEPAY_SECRET, webhookSecret: FAKEPAY_WEBHOOK_SECRET } });
  await upsertCredential(deps, ACTOR, { storeId, kind: "payment", provider: "cod", mode: "live" }, { config: {} });
  const product = await createProduct(deps, ACTOR, storeId, teeInput({ variants: teeInput().variants.map((v) => ({ ...v, inventory: [{ available: 5 }] })) }));
  const variants = await deps.db.select().from(productVariants).where(eq(productVariants.productId, product.id)).orderBy(asc(productVariants.position));
  return { storeId, productId: product.id, variants };
}

export async function orderRow(deps: TestDeps, id: string) {
  const [o] = await deps.db.select().from(orders).where(eq(orders.id, id));
  return o!;
}

/** A signed FakePay refund webhook (processed or failed). */
export function refundWebhook(refundId: string, amount: number, status: "refund.processed" | "refund.failed" = "refund.processed") {
  const body = Buffer.from(JSON.stringify({ id: `evt_${refundId}_${status}`, type: status, payment: null, refund: { id: refundId, amount, status } }));
  return { body, headers: { "x-fakepay-signature": sign(body.toString(), FAKEPAY_WEBHOOK_SECRET) } };
}
