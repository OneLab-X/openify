import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { http, HttpResponse, type HttpHandler } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { bankTransfer } from "../src/payments/bank-transfer.js";
import { CASHFREE_API, cashfree } from "../src/payments/cashfree.js";
import { cod } from "../src/payments/cod.js";
import { PAYPAL_API, paypal } from "../src/payments/paypal.js";
import { PHONEPE_API, phonepe } from "../src/payments/phonepe.js";
import { RAZORPAY_API, razorpay } from "../src/payments/razorpay.js";
import { STRIPE_API, stripe } from "../src/payments/stripe.js";
import {
  ProviderError,
  WebhookSignatureError,
  type PaymentProvider,
  type PaymentSession,
  type PaymentSessionInput,
  type ProviderDefinition,
} from "../src/types.js";
import { ctx } from "./helpers.js";

/**
 * SPEC §7 contract every payment adapter must pass, driven by recorded fixtures
 * (test/fixtures/payments/<provider>/*.json) served through msw.
 */
const ORDER_ID = "0190a1b2-0000-7000-8000-00000000abcd";
const fixture = <T = Record<string, unknown>>(provider: string, name: string): T =>
  JSON.parse(readFileSync(new URL(`./fixtures/payments/${provider}/${name}.json`, import.meta.url), "utf8")) as T;
const raw = (provider: string, name: string, patch?: (o: Record<string, unknown>) => void) => {
  const obj = fixture(provider, name);
  patch?.(obj);
  return Buffer.from(JSON.stringify(obj));
};
const hmacHex = (secret: string, ...parts: (string | Buffer)[]) => parts.reduce((h, p) => h.update(p), createHmac("sha256", secret)).digest("hex");

interface SignedBody {
  body: Buffer;
  headers: Record<string, string>;
}

interface Harness {
  def: ProviderDefinition<"payment">;
  config: Record<string, unknown>;
  secrets: Record<string, unknown>;
  amount: number;
  currency: string;
  handlers: HttpHandler[];
  /** Strings that must never reach the browser. */
  secretValues: string[];
  validReturn(session: PaymentSession): Record<string, unknown>;
  tamperedReturn(session: PaymentSession): Record<string, unknown>;
  webhook(kind: "captured" | "failed"): SignedBody;
  forgedWebhook(): SignedBody;
  paymentId: string;
  /** Provider order id the captured payment belongs to. */
  providerOrderId: string;
}

// ── Harnesses ────────────────────────────────────────────────────────────────
const rzpSecrets = { keySecret: "rzp_key_secret_123", webhookSecret: "rzp_webhook_secret_123" };
const razorpayHarness: Harness = {
  def: razorpay,
  config: { keyId: "rzp_test_Contract1" },
  secrets: rzpSecrets,
  amount: 49900,
  currency: "INR",
  secretValues: Object.values(rzpSecrets),
  handlers: [
    http.get(`${RAZORPAY_API}/orders`, () => HttpResponse.json({ items: [] })),
    http.post(`${RAZORPAY_API}/orders`, () => HttpResponse.json(fixture("razorpay", "order"))),
    http.get(`${RAZORPAY_API}/payments/pay_Pk1`, () => HttpResponse.json(fixture("razorpay", "payment_captured"))),
    http.post(`${RAZORPAY_API}/payments/pay_Pk1/refund`, () => HttpResponse.json(fixture("razorpay", "refund"))),
  ],
  validReturn: () => ({ razorpay_order_id: "order_Pk1", razorpay_payment_id: "pay_Pk1", razorpay_signature: hmacHex(rzpSecrets.keySecret, "order_Pk1|pay_Pk1") }),
  tamperedReturn: () => ({ razorpay_order_id: "order_Pk1", razorpay_payment_id: "pay_Pk1", razorpay_signature: hmacHex("not-the-secret", "order_Pk1|pay_Pk1") }),
  webhook(kind) {
    const body = raw("razorpay", `webhook_${kind}`);
    return { body, headers: { "x-razorpay-signature": hmacHex(rzpSecrets.webhookSecret, body), "x-razorpay-event-id": `evt_rzp_${kind}` } };
  },
  forgedWebhook() {
    const body = raw("razorpay", "webhook_captured", (o) => ((o.payload as { payment: { entity: { amount: number } } }).payment.entity.amount = 1));
    return { body, headers: { "x-razorpay-signature": hmacHex(rzpSecrets.webhookSecret, raw("razorpay", "webhook_captured")), "x-razorpay-event-id": "evt_forged" } };
  },
  paymentId: "pay_Pk1",
  providerOrderId: "order_Pk1",
};

const stripeSecrets = { secretKey: "sk_test_Contract1", webhookSecret: "whsec_contract_123" };
const stripeSign = (body: Buffer, secret = stripeSecrets.webhookSecret) => {
  const t = Math.floor(Date.now() / 1000);
  return `t=${t},v1=${hmacHex(secret, `${t}.`, body)}`;
};
const stripeHarness: Harness = {
  def: stripe,
  config: { publishableKey: "pk_test_Contract1" },
  secrets: stripeSecrets,
  amount: 49900,
  currency: "INR",
  secretValues: Object.values(stripeSecrets),
  handlers: [
    http.get(`${STRIPE_API}/payment_intents`, () => HttpResponse.json({ data: [] })),
    http.post(`${STRIPE_API}/payment_intents`, () => HttpResponse.json(fixture("stripe", "payment_intent_created"))),
    http.get(`${STRIPE_API}/payment_intents/pi_3Pk1`, () => HttpResponse.json(fixture("stripe", "payment_intent_succeeded"))),
    http.post(`${STRIPE_API}/refunds`, () => HttpResponse.json(fixture("stripe", "refund"))),
  ],
  validReturn: (s) => ({ payment_intent: "pi_3Pk1", payment_intent_client_secret: s.clientPayload.clientSecret, redirect_status: "succeeded" }),
  tamperedReturn: () => ({ payment_intent: "pi_3Pk1", payment_intent_client_secret: "pi_3Pk1_secret_forged", redirect_status: "succeeded" }),
  webhook(kind) {
    const body = raw("stripe", `webhook_${kind}`);
    return { body, headers: { "stripe-signature": stripeSign(body) } };
  },
  forgedWebhook() {
    const body = raw("stripe", "webhook_captured");
    return { body, headers: { "stripe-signature": stripeSign(body, "whsec_attacker") } };
  },
  paymentId: "pi_3Pk1",
  providerOrderId: "pi_3Pk1",
};

const PP = PAYPAL_API.test;
const paypalHarness: Harness = {
  def: paypal,
  config: { clientId: "AcontractClientId", webhookId: "WH-ID-1" },
  secrets: { clientSecret: "EcontractSecret" },
  amount: 4990,
  currency: "USD",
  secretValues: ["EcontractSecret"],
  handlers: [
    http.post(`${PP}/v1/oauth2/token`, () => HttpResponse.json(fixture("paypal", "token"))),
    http.post(`${PP}/v2/checkout/orders`, () => HttpResponse.json(fixture("paypal", "order_created"), { status: 201 })),
    http.post(`${PP}/v2/checkout/orders/5O190127TN364715T/capture`, () => HttpResponse.json(fixture("paypal", "order_captured"), { status: 201 })),
    http.post(`${PP}/v2/checkout/orders/FORGED0000TOKEN/capture`, () => HttpResponse.json({ name: "RESOURCE_NOT_FOUND", message: "The specified resource does not exist." }, { status: 404 })),
    http.get(`${PP}/v2/payments/captures/3C679366HH908993F`, () => HttpResponse.json(fixture("paypal", "capture"))),
    http.post(`${PP}/v2/payments/captures/3C679366HH908993F/refund`, () => HttpResponse.json(fixture("paypal", "refund"), { status: 201 })),
    http.post(`${PP}/v1/notifications/verify-webhook-signature`, async ({ request }) => {
      const body = (await request.json()) as { transmission_sig?: string; webhook_id?: string };
      return HttpResponse.json({ verification_status: body.transmission_sig === "good-sig" && body.webhook_id === "WH-ID-1" ? "SUCCESS" : "FAILURE" });
    }),
  ],
  validReturn: () => ({ token: "5O190127TN364715T", PayerID: "PAYER1" }),
  tamperedReturn: () => ({ token: "not a token!" }),
  webhook: (kind) => ({ body: raw("paypal", `webhook_${kind}`), headers: { "paypal-transmission-sig": "good-sig", "paypal-transmission-id": "t1", "paypal-auth-algo": "SHA256withRSA" } }),
  forgedWebhook: () => ({ body: raw("paypal", "webhook_captured"), headers: { "paypal-transmission-sig": "forged", "paypal-transmission-id": "t1" } }),
  paymentId: "3C679366HH908993F",
  providerOrderId: "5O190127TN364715T",
};

const CF = CASHFREE_API.test;
const cfOrder = fixture<{ order_id: string }>("cashfree", "order").order_id;
const cfSecret = "cf_secret_contract_123";
const cfSign = (body: Buffer, secret = cfSecret) => {
  const ts = String(Math.floor(Date.now() / 1000));
  return { "x-webhook-timestamp": ts, "x-webhook-signature": createHmac("sha256", secret).update(ts).update(body).digest("base64") };
};
const cashfreeHarness: Harness = {
  def: cashfree,
  config: { clientId: "TEST_APP_1" },
  secrets: { clientSecret: cfSecret },
  amount: 49900,
  currency: "INR",
  secretValues: [cfSecret],
  handlers: [
    http.get(`${CF}/orders/shopkit_credentials_check`, () => HttpResponse.json({ message: "order not found" }, { status: 404 })),
    http.post(`${CF}/orders`, () => HttpResponse.json(fixture("cashfree", "order"))),
    http.get(`${CF}/orders/${cfOrder}`, () => HttpResponse.json(fixture("cashfree", "order"))),
    http.get(`${CF}/orders/${cfOrder}/payments`, () => HttpResponse.json(fixture("cashfree", "payments"))),
    http.get(`${CF}/orders/${cfOrder}/payments/5114910513`, () => HttpResponse.json(fixture<Record<string, unknown>[]>("cashfree", "payments")[0])),
    http.get(`${CF}/orders/sk_forged`, () => HttpResponse.json({ message: "order not found" }, { status: 404 })),
    http.post(`${CF}/orders/${cfOrder}/refunds`, () => HttpResponse.json(fixture("cashfree", "refund"))),
  ],
  validReturn: () => ({ cf_order_id: cfOrder }),
  tamperedReturn: () => ({ cf_order_id: "sk_forged" }),
  webhook(kind) {
    const body = raw("cashfree", `webhook_${kind}`);
    return { body, headers: cfSign(body) };
  },
  forgedWebhook() {
    const body = raw("cashfree", "webhook_captured");
    return { body, headers: cfSign(body, "attacker") };
  },
  paymentId: `${cfOrder}:5114910513`,
  providerOrderId: cfOrder,
};

const PPE = PHONEPE_API.test.pg;
let phonepeMerchantOrderId = "";
const ppAuth = (user = "shopkit", pass = "callback-pass") => createHash("sha256").update(`${user}:${pass}`).digest("hex");
const ppWebhook = (kind: "captured" | "failed") =>
  raw("phonepe", `webhook_${kind}`, (o) => ((o.payload as { merchantOrderId: string }).merchantOrderId = phonepeMerchantOrderId));
const phonepeHarness: Harness = {
  def: phonepe,
  config: { clientId: "TEST_CLIENT", clientVersion: 1, webhookUsername: "shopkit" },
  secrets: { clientSecret: "pp_secret_contract", webhookPassword: "callback-pass" },
  amount: 49900,
  currency: "INR",
  secretValues: ["pp_secret_contract", "callback-pass"],
  handlers: [
    http.post(`${PHONEPE_API.test.auth}/v1/oauth/token`, () => HttpResponse.json(fixture("phonepe", "token"))),
    http.post(`${PPE}/checkout/v2/pay`, async ({ request }) => {
      phonepeMerchantOrderId = ((await request.json()) as { merchantOrderId: string }).merchantOrderId;
      return HttpResponse.json(fixture("phonepe", "pay"));
    }),
    http.get(`${PPE}/checkout/v2/order/:id/status`, ({ params }) =>
      params.id === phonepeMerchantOrderId ? HttpResponse.json(fixture("phonepe", "status_completed")) : HttpResponse.json({ message: "Order not found" }, { status: 404 }),
    ),
    http.post(`${PPE}/payments/v2/refund`, () => HttpResponse.json(fixture("phonepe", "refund"))),
  ],
  validReturn: (s) => ({ merchantOrderId: s.providerOrderId }),
  tamperedReturn: () => ({ merchantOrderId: "../../etc" }),
  webhook: (kind) => ({ body: ppWebhook(kind), headers: { authorization: ppAuth() } }),
  forgedWebhook: () => ({ body: ppWebhook("captured"), headers: { authorization: ppAuth("shopkit", "guess") } }),
  get paymentId() {
    return phonepeMerchantOrderId;
  },
  get providerOrderId() {
    return phonepeMerchantOrderId;
  },
};

// ── Contract ─────────────────────────────────────────────────────────────────
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const input = (h: Harness, amount = h.amount): PaymentSessionInput => ({
  order: { id: ORDER_ID, number: "#1001" },
  amount,
  currency: h.currency,
  customer: { name: "Asha Kumar", email: "asha@example.com", phone: "+91 98765 43210" },
  returnUrl: "https://shop.test/checkout/return?checkout=c1",
});

for (const h of [razorpayHarness, stripeHarness, paypalHarness, cashfreeHarness, phonepeHarness]) {
  describe(`payment contract: ${h.def.id}`, () => {
    let provider: PaymentProvider;
    const make = () => h.def.create(ctx(h.config, h.secrets, "test"));
    beforeAll(() => {
      provider = make();
    });
    const withFixtures = () => server.use(...h.handlers);

    it("declares schemas, webhook events and a payment flow", () => {
      expect(h.def.kind).toBe("payment");
      expect(h.def.configSchema.safeParse(h.config).success).toBe(true);
      expect(h.def.secretsSchema.safeParse(h.secrets).success).toBe(true);
      expect(h.def.webhookEvents?.length).toBeGreaterThan(0);
      expect(["widget", "redirect"]).toContain(h.def.paymentFlow);
      expect(h.def.modes).toEqual(["test", "live"]);
    });

    it("testCredentials succeeds against the provider", async () => {
      withFixtures();
      await expect(make().testCredentials()).resolves.toMatchObject({ ok: true });
    });

    it("refuses non-integer and non-positive amounts before calling the provider", async () => {
      for (const bad of [0, -100, 10.5]) await expect(provider.createSession(input(h, bad))).rejects.toThrow(ProviderError);
    });

    it("createSession returns a provider reference and a browser payload without secrets", async () => {
      withFixtures();
      const session = await provider.createSession(input(h));
      expect(typeof session.providerOrderId).toBe("string");
      expect(session.clientPayload.provider).toBe(h.def.id);
      if (h.def.paymentFlow === "redirect") expect(session.redirectUrl).toMatch(/^https:\/\//);
      const json = JSON.stringify(session);
      for (const secret of h.secretValues) expect(json).not.toContain(secret);
    });

    it("verifyReturn confirms a genuine return and reports the captured amount", async () => {
      withFixtures();
      const session = await provider.createSession(input(h));
      const result = await provider.verifyReturn(h.validReturn(session));
      expect(result).toMatchObject({ status: "captured", amount: h.amount, currency: h.currency, providerOrderId: h.providerOrderId });
      expect(result.providerPaymentId).toBe(h.paymentId);
      expect(result.orderReference ?? ORDER_ID).toBe(ORDER_ID);
    });

    it("verifyReturn rejects a tampered return", async () => {
      withFixtures();
      const session = await provider.createSession(input(h));
      await expect(provider.verifyReturn(h.tamperedReturn(session))).rejects.toThrow(Error);
    });

    it("parseWebhook verifies the signature on the raw body and normalises events", async () => {
      withFixtures();
      if (h.def.id === "phonepe") await provider.createSession(input(h));
      const captured = h.webhook("captured");
      const event = await provider.parseWebhook(captured.body, captured.headers);
      expect(event.type).toBe("payment.captured");
      expect(event.payment).toMatchObject({ status: "captured", amount: h.amount, currency: h.currency });
      expect(event.id).toBeTruthy();
      // Same delivery → same id, so the dedupe key is stable across retries.
      expect((await provider.parseWebhook(captured.body, captured.headers)).id).toBe(event.id);

      const failed = h.webhook("failed");
      const failedEvent = await provider.parseWebhook(failed.body, failed.headers);
      expect(failedEvent.type).toBe("payment.failed");
      expect(failedEvent.id).not.toBe(event.id);
    });

    it("parseWebhook rejects a forged or re-signed body", async () => {
      withFixtures();
      const forged = h.forgedWebhook();
      await expect(provider.parseWebhook(forged.body, forged.headers)).rejects.toThrow(WebhookSignatureError);
      await expect(provider.parseWebhook(forged.body, {})).rejects.toThrow(WebhookSignatureError);
    });

    it("refund returns a refund transaction", async () => {
      withFixtures();
      if (h.def.id === "phonepe") await provider.createSession(input(h));
      const tx = await provider.refund(h.paymentId, h.def.id === "paypal" ? 1000 : 10000, "Damaged", "0190a1b2-0000-7000-8000-0000000000ff");
      expect(tx).toMatchObject({ kind: "refund", currency: h.currency });
      expect(tx.amount).toBeGreaterThan(0);
      expect(["pending", "success"]).toContain(tx.status);
    });

    it("getPayment reads the payment's current state", async () => {
      withFixtures();
      if (h.def.id === "phonepe") await provider.createSession(input(h));
      await expect(provider.getPayment(h.paymentId)).resolves.toMatchObject({ status: "captured", amount: h.amount });
    });

    it("uses the local sandbox only in test mode", async () => {
      const sandbox = { internalUrl: "http://sandbox.internal", publicUrl: "https://shop.test/__sandbox" };
      let hit = false;
      server.use(http.all("http://sandbox.internal/*", () => ((hit = true), HttpResponse.json({}, { status: 500 }))), ...h.handlers);
      const live = h.def.create(ctx(liveConfig(h), liveSecrets(h), "live", { paymentSandbox: sandbox }));
      await live.testCredentials();
      expect(hit).toBe(false);
      const test = h.def.create(ctx(h.config, h.secrets, "test", { paymentSandbox: sandbox }));
      await test.testCredentials();
      expect(hit).toBe(true);
    });
  });
}

function liveConfig(h: Harness) {
  if (h.def.id === "razorpay") return { keyId: "rzp_live_Contract1" };
  if (h.def.id === "stripe") return { publishableKey: "pk_live_Contract1" };
  return h.config;
}
function liveSecrets(h: Harness) {
  if (h.def.id === "stripe") return { ...h.secrets, secretKey: "sk_live_Contract1" };
  return h.secrets;
}

describe("payment contract: offline methods", () => {
  for (const def of [cod, bankTransfer] as ProviderDefinition<"payment">[]) {
    it(`${def.id} places orders without a provider round trip`, async () => {
      expect(def.paymentFlow).toBe("offline");
      const config = def.id === "bank-transfer" ? { accountDetails: "HDFC 0001 IFSC HDFC0000001" } : {};
      const p = def.create(ctx(config, {}, "live"));
      await expect(p.testCredentials()).resolves.toMatchObject({ ok: true });
      const session = await p.createSession({ ...input(razorpayHarness), currency: "INR" });
      expect(session.providerOrderId).toBeNull();
      expect(session.clientPayload.provider).toBe(def.id);
      await expect(p.verifyReturn({})).rejects.toThrow(WebhookSignatureError);
      await expect(p.parseWebhook(Buffer.from("{}"), {})).rejects.toThrow(WebhookSignatureError);
      await expect(p.refund("x", 1)).rejects.toThrow(ProviderError);
    });
  }
});
