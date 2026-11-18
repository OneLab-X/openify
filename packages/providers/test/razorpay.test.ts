import { createHmac } from "node:crypto";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { RAZORPAY_API, razorpay } from "../src/payments/razorpay.js";
import { ProviderError, WebhookSignatureError } from "../src/types.js";
import { ctx } from "./helpers.js";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const secrets = { keySecret: "test_key_secret_123", webhookSecret: "webhook_secret_123" };
const make = (mode: "test" | "live" = "test", keyId = "rzp_test_abc123") =>
  razorpay.create(ctx({ keyId }, secrets, mode));
const sign = (s: string, secret: string) => createHmac("sha256", secret).update(s).digest("hex");

const payment = {
  id: "pay_1", order_id: "order_1", amount: 49900, amount_refunded: 0, currency: "INR",
  status: "captured", method: "upi", notes: { orderId: "ord-uuid" },
};

describe("razorpay", () => {
  it("validates config", () => {
    expect(razorpay.configSchema.safeParse({ keyId: "nope" }).success).toBe(false);
    expect(razorpay.configSchema.safeParse({ keyId: "rzp_live_X1" }).success).toBe(true);
  });

  it("testCredentials succeeds with a read-only call using basic auth", async () => {
    let auth = "";
    server.use(http.get(`${RAZORPAY_API}/orders`, ({ request }) => {
      auth = request.headers.get("authorization") ?? "";
      return HttpResponse.json({ items: [] });
    }));
    await expect(make().testCredentials()).resolves.toEqual({ ok: true });
    expect(auth).toBe(`Basic ${Buffer.from("rzp_test_abc123:test_key_secret_123").toString("base64")}`);
  });

  it("testCredentials reports Razorpay's error message", async () => {
    server.use(http.get(`${RAZORPAY_API}/orders`, () =>
      HttpResponse.json({ error: { description: "Authentication failed" } }, { status: 401 })));
    await expect(make().testCredentials()).resolves.toEqual({ ok: false, error: "Authentication failed" });
  });

  it("testCredentials rejects a live key saved as test mode", async () => {
    const res = await make("test", "rzp_live_abc").testCredentials();
    expect(res).toMatchObject({ ok: false, error: expect.stringMatching(/live key/) });
  });

  it("createSession sends our order id as receipt and never trusts a browser amount", async () => {
    let body: Record<string, unknown> = {};
    server.use(http.post(`${RAZORPAY_API}/orders`, async ({ request }) => {
      body = (await request.json()) as Record<string, unknown>;
      return HttpResponse.json({ id: "order_1", amount: 49900, currency: "INR", receipt: "ord-uuid", status: "created" });
    }));
    const session = await make().createSession({
      order: { id: "ord-uuid", number: "#1001" }, amount: 49900, currency: "INR",
      customer: { email: "a@b.co" }, returnUrl: "https://shop.test/thanks",
    });
    expect(body).toMatchObject({ amount: 49900, currency: "INR", receipt: "ord-uuid", notes: { orderId: "ord-uuid" } });
    expect(session.providerOrderId).toBe("order_1");
    expect(session.clientPayload).toMatchObject({ keyId: "rzp_test_abc123", orderId: "order_1" });
    expect(JSON.stringify(session)).not.toContain(secrets.keySecret);
    await expect(make().createSession({ order: { id: "x" }, amount: 10.5, currency: "INR", customer: {}, returnUrl: "" }))
      .rejects.toThrow(ProviderError);
  });

  it("verifyReturn checks the checkout signature and the payment's order", async () => {
    server.use(http.get(`${RAZORPAY_API}/payments/pay_1`, () => HttpResponse.json(payment)));
    const ok = await make().verifyReturn({
      razorpay_order_id: "order_1", razorpay_payment_id: "pay_1",
      razorpay_signature: sign("order_1|pay_1", secrets.keySecret),
    });
    expect(ok).toMatchObject({ status: "captured", amount: 49900, orderReference: "ord-uuid" });

    await expect(make().verifyReturn({
      razorpay_order_id: "order_1", razorpay_payment_id: "pay_1", razorpay_signature: sign("order_1|pay_2", secrets.keySecret),
    })).rejects.toThrow(WebhookSignatureError);
    await expect(make().verifyReturn({ razorpay_order_id: "order_1" })).rejects.toThrow(WebhookSignatureError);
    await expect(make().verifyReturn({
      razorpay_order_id: "order_2", razorpay_payment_id: "pay_1", razorpay_signature: sign("order_2|pay_1", secrets.keySecret),
    })).rejects.toThrow(/does not belong/);
  });

  it("parseWebhook verifies the raw body and normalises the event", async () => {
    const raw = Buffer.from(JSON.stringify({ event: "payment.captured", payload: { payment: { entity: payment } } }));
    const headers = { "x-razorpay-signature": sign(raw.toString(), secrets.webhookSecret), "x-razorpay-event-id": "evt_1" };
    const evt = await make().parseWebhook(raw, headers);
    expect(evt).toMatchObject({ id: "evt_1", type: "payment.captured", payment: { providerPaymentId: "pay_1" } });

    const reformatted = Buffer.from(JSON.stringify(JSON.parse(raw.toString()), null, 2));
    await expect(make().parseWebhook(reformatted, headers)).rejects.toThrow(WebhookSignatureError);
    await expect(make().parseWebhook(raw, { ...headers, "x-razorpay-event-id": undefined })).rejects.toThrow(/event-id/);
    const noSecret = razorpay.create(ctx({ keyId: "rzp_test_a" }, { keySecret: "x".repeat(10) }));
    await expect(noSecret.parseWebhook(raw, headers)).rejects.toThrow(/not configured/);
  });

  it("parseWebhook maps refunds and unknown events", async () => {
    const refundBody = Buffer.from(JSON.stringify({
      event: "refund.processed",
      payload: { refund: { entity: { id: "rfnd_1", payment_id: "pay_1", amount: 100, currency: "INR", status: "processed" } },
        payment: { entity: { ...payment, amount_refunded: 100 } } },
    }));
    const h = (b: Buffer) => ({ "x-razorpay-signature": sign(b.toString(), secrets.webhookSecret), "x-razorpay-event-id": "e" });
    const evt = await make().parseWebhook(refundBody, h(refundBody));
    expect(evt).toMatchObject({ type: "refund.processed", refund: { id: "rfnd_1" }, payment: { status: "partially_refunded" } });
    const other = Buffer.from(JSON.stringify({ event: "invoice.paid", payload: {} }));
    expect(await make().parseWebhook(other, h(other))).toMatchObject({ type: "unknown", payment: null, refund: null });
  });

  it("refund, capture and getPayment", async () => {
    server.use(
      http.post(`${RAZORPAY_API}/payments/pay_1/refund`, () =>
        HttpResponse.json({ id: "rfnd_1", payment_id: "pay_1", amount: 100, currency: "INR", status: "pending" })),
      http.post(`${RAZORPAY_API}/payments/pay_1/capture`, () => HttpResponse.json({ ...payment, status: "captured" })),
      http.get(`${RAZORPAY_API}/payments/pay_2`, () =>
        HttpResponse.json({ ...payment, id: "pay_2", status: "failed", amount_refunded: 0, notes: [] })),
    );
    const p = make();
    await expect(p.refund("pay_1", 100, "damaged")).resolves.toMatchObject({ kind: "refund", status: "pending", amount: 100 });
    await expect(p.capture!("pay_1", 49900, "INR")).resolves.toMatchObject({ kind: "capture", status: "success" });
    await expect(p.getPayment("pay_2")).resolves.toMatchObject({ status: "failed", orderReference: null });
  });
});
