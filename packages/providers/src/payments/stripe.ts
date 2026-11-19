import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { errorMessage, header, request } from "../http.js";
import {
  ProviderError,
  WebhookSignatureError,
  type NormalizedWebhookType,
  type PaymentProvider,
  type PaymentResult,
  type PaymentStatus,
  type PaymentTransaction,
  type ProviderContext,
  type ProviderDefinition,
} from "../types.js";
import { assertAmount } from "./money.js";

/**
 * Stripe Payment Intents (https://docs.stripe.com/api/payment_intents), over fetch. The browser
 * mounts the Payment Element with the intent's client secret and Stripe redirects back to our
 * return URL with `payment_intent`; the `Stripe-Signature` webhook is the source of truth.
 */
export const STRIPE_API = "https://api.stripe.com/v1";
export const STRIPE_JS = "https://js.stripe.com/v3/";
/** Stripe's documented default tolerance for webhook timestamps. */
export const STRIPE_WEBHOOK_TOLERANCE_SECONDS = 300;

const configSchema = z.object({
  publishableKey: z
    .string()
    .regex(/^pk_(test|live)_[A-Za-z0-9]+$/, "Publishable key looks like pk_test_… or pk_live_…")
    .meta({ title: "Publishable key", description: "Developers → API keys" }),
});
const secretsSchema = z.object({
  secretKey: z
    .string()
    .regex(/^(sk|rk)_(test|live)_[A-Za-z0-9]+$/, "Secret key looks like sk_test_… (or a restricted rk_ key)")
    .meta({ title: "Secret key" }),
  webhookSecret: z
    .string()
    .startsWith("whsec_", "Signing secret starts with whsec_")
    .optional()
    .meta({ title: "Webhook signing secret", description: "Developers → Webhooks → your endpoint → Signing secret" }),
});
export type StripeConfig = z.infer<typeof configSchema>;
export type StripeSecrets = z.infer<typeof secretsSchema>;

interface StripeCharge {
  id: string;
  amount: number;
  amount_refunded: number;
  payment_method_details?: { type?: string } | null;
}
interface StripeIntent {
  id: string;
  object: "payment_intent";
  amount: number;
  amount_received: number;
  currency: string;
  status: "requires_payment_method" | "requires_confirmation" | "requires_action" | "processing" | "requires_capture" | "canceled" | "succeeded";
  client_secret: string;
  metadata: Record<string, string>;
  last_payment_error?: { message?: string } | null;
  latest_charge?: string | StripeCharge | null;
}
interface StripeRefund {
  id: string;
  amount: number;
  currency: string;
  payment_intent: string | null;
  status: "pending" | "requires_action" | "succeeded" | "failed" | "canceled";
}

/** Stripe wants application/x-www-form-urlencoded with bracketed nested keys. */
export function formEncode(data: Record<string, unknown>, prefix = ""): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === "object") parts.push(formEncode(v as Record<string, unknown>, key));
    else parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(v as string | number | boolean)}`);
  }
  return parts.filter(Boolean).join("&");
}

function toResult(pi: StripeIntent): PaymentResult {
  const charge = typeof pi.latest_charge === "object" && pi.latest_charge ? pi.latest_charge : null;
  const refunded = charge?.amount_refunded ?? 0;
  let status: PaymentStatus;
  if (refunded > 0) status = refunded >= pi.amount_received ? "refunded" : "partially_refunded";
  else if (pi.status === "succeeded") status = "captured";
  else if (pi.status === "requires_capture") status = "authorized";
  else if (pi.status === "canceled" || (pi.status === "requires_payment_method" && pi.last_payment_error)) status = "failed";
  else status = "pending";
  return {
    status,
    providerPaymentId: pi.id,
    providerOrderId: pi.id,
    amount: pi.status === "succeeded" ? pi.amount_received : pi.amount,
    amountRefunded: refunded,
    currency: pi.currency.toUpperCase(),
    method: charge?.payment_method_details?.type ?? null,
    errorDescription: pi.last_payment_error?.message ?? null,
    orderReference: pi.metadata.order_id ?? null,
  };
}

/** Verifies `Stripe-Signature: t=…,v1=…` over `${t}.${rawBody}` (https://docs.stripe.com/webhooks#verify-manually). */
export function verifyStripeSignature(rawBody: Buffer, signatureHeader: string | undefined, secret: string, nowSeconds: number): void {
  if (!signatureHeader) throw new WebhookSignatureError("Missing Stripe-Signature header");
  const parts = signatureHeader.split(",").map((p) => p.split("=", 2) as [string, string]);
  const t = parts.find(([k]) => k === "t")?.[1];
  const v1 = parts.filter(([k]) => k === "v1").map(([, v]) => v);
  if (!t || !/^\d+$/.test(t) || v1.length === 0) throw new WebhookSignatureError("Malformed Stripe-Signature header");
  if (Math.abs(nowSeconds - Number(t)) > STRIPE_WEBHOOK_TOLERANCE_SECONDS) throw new WebhookSignatureError("Stripe webhook timestamp is outside the tolerance");
  const expected = createHmac("sha256", secret).update(`${t}.`).update(rawBody).digest();
  const ok = v1.some((sig) => /^[0-9a-f]{64}$/i.test(sig) && timingSafeEqual(expected, Buffer.from(sig, "hex")));
  if (!ok) throw new WebhookSignatureError("Invalid Stripe webhook signature");
}

const EVENT_MAP: Record<string, NormalizedWebhookType> = {
  "payment_intent.succeeded": "payment.captured",
  "payment_intent.amount_capturable_updated": "payment.authorized",
  "payment_intent.payment_failed": "payment.failed",
  "payment_intent.canceled": "payment.failed",
  "charge.refunded": "refund.processed",
  "refund.failed": "refund.failed",
};

export function createStripe(ctx: ProviderContext<StripeConfig, StripeSecrets>, clock: () => number = Date.now): PaymentProvider {
  const sandbox = ctx.mode === "test" ? ctx.runtime.paymentSandbox : undefined;
  const apiBase = sandbox ? `${sandbox.internalUrl}/stripe/v1` : STRIPE_API;
  const scriptUrl = sandbox ? `${sandbox.publicUrl}/stripe/v3.js` : STRIPE_JS;
  const auth = `Bearer ${ctx.secrets.secretKey}`;

  async function call<T>(method: "GET" | "POST", path: string, body?: Record<string, unknown>, idempotencyKey?: string): Promise<T> {
    const res = await request(`${apiBase}${path}`, {
      method,
      headers: {
        Authorization: auth,
        ...(body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
        ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      },
      ...(body ? { body: formEncode(body) } : {}),
    });
    const data = (await res.json().catch(() => ({}))) as { error?: { message?: string } } & T;
    if (!res.ok) throw new ProviderError(data.error?.message ?? `Stripe error (${res.status})`, res.status);
    return data;
  }

  function assertModeMatchesKeys() {
    const pk = ctx.config.publishableKey.includes("_live_") ? "live" : "test";
    const sk = ctx.secrets.secretKey.includes("_live_") ? "live" : "test";
    if (pk !== sk) throw new ProviderError("The publishable and secret keys are from different modes");
    if (sk !== ctx.mode) throw new ProviderError(`These are ${sk} keys but the credential is for ${ctx.mode} mode`);
  }

  const getIntent = (id: string) => call<StripeIntent>("GET", `/payment_intents/${encodeURIComponent(id)}?expand[]=latest_charge`);
  const getPayment = async (paymentId: string) => toResult(await getIntent(paymentId));

  return {
    async testCredentials() {
      try {
        assertModeMatchesKeys();
        await call("GET", "/payment_intents?limit=1");
        return { ok: true };
      } catch (err) {
        return { ok: false, error: errorMessage(err) };
      }
    },

    async createSession({ order, amount, currency, customer, returnUrl }) {
      try {
        assertAmount(amount);
      } catch (err) {
        throw new ProviderError(errorMessage(err));
      }
      // One intent per (order, amount): retrying the same session reuses Stripe's intent.
      const pi = await call<StripeIntent>(
        "POST",
        "/payment_intents",
        {
          amount,
          currency: currency.toLowerCase(),
          automatic_payment_methods: { enabled: true },
          metadata: { order_id: order.id, ...(order.number ? { order_number: order.number } : {}) },
          ...(customer.email ? { receipt_email: customer.email } : {}),
        },
        `shopkit-${order.id}-${amount}-${currency}`,
      );
      return {
        providerOrderId: pi.id,
        clientPayload: {
          provider: "stripe",
          scriptUrl,
          publishableKey: ctx.config.publishableKey,
          clientSecret: pi.client_secret,
          returnUrl,
          amount: pi.amount,
          currency: pi.currency.toUpperCase(),
        },
      };
    },

    /** Stripe appends `payment_intent` and `payment_intent_client_secret` to the return URL. */
    async verifyReturn(payload) {
      const id = payload.payment_intent;
      const secret = payload.payment_intent_client_secret;
      if (typeof id !== "string" || !/^pi_[A-Za-z0-9]+$/.test(id)) throw new WebhookSignatureError("Missing Stripe payment_intent");
      const pi = await getIntent(id);
      // The client secret proves the return came from the browser that started this intent.
      if (typeof secret !== "string" || secret.length !== pi.client_secret.length || !timingSafeEqual(Buffer.from(secret), Buffer.from(pi.client_secret))) {
        throw new WebhookSignatureError("Stripe client secret does not match the payment");
      }
      return toResult(pi);
    },

    async parseWebhook(rawBody, headers) {
      const secret = ctx.secrets.webhookSecret;
      if (!secret) throw new WebhookSignatureError("Stripe webhook signing secret is not configured");
      verifyStripeSignature(rawBody, header(headers, "stripe-signature"), secret, Math.floor(clock() / 1000));
      const event = JSON.parse(rawBody.toString("utf8")) as { id: string; type: string; data: { object: Record<string, unknown> } };
      const obj = event.data.object;
      let payment: PaymentResult | null = null;
      let refund: { id: string; amount: number; status: string } | null = null;
      if (obj.object === "payment_intent") payment = toResult(obj as unknown as StripeIntent);
      if (obj.object === "charge") {
        const charge = obj as unknown as StripeCharge & { payment_intent: string; currency: string; metadata: Record<string, string> };
        payment = {
          status: charge.amount_refunded >= charge.amount ? "refunded" : charge.amount_refunded > 0 ? "partially_refunded" : "captured",
          providerPaymentId: charge.payment_intent,
          providerOrderId: charge.payment_intent,
          amount: charge.amount,
          amountRefunded: charge.amount_refunded,
          currency: charge.currency.toUpperCase(),
          method: charge.payment_method_details?.type ?? null,
          orderReference: charge.metadata?.order_id ?? null,
        };
        const refunds = (obj.refunds as { data?: StripeRefund[] } | undefined)?.data ?? [];
        const latest = refunds[0];
        if (latest) refund = { id: latest.id, amount: latest.amount, status: latest.status };
      }
      if (obj.object === "refund") {
        const r = obj as unknown as StripeRefund;
        refund = { id: r.id, amount: r.amount, status: r.status };
      }
      return { id: event.id, providerType: event.type, type: EVENT_MAP[event.type] ?? "unknown", payment, refund, raw: event };
    },

    async refund(paymentId, amount, reason, idempotencyKey): Promise<PaymentTransaction> {
      const r = await call<StripeRefund>(
        "POST",
        "/refunds",
        { payment_intent: paymentId, amount, metadata: reason ? { reason: reason.slice(0, 450) } : undefined },
        idempotencyKey ? `shopkit-refund-${idempotencyKey}` : undefined,
      );
      const status = r.status === "succeeded" ? "success" : r.status === "failed" || r.status === "canceled" ? "failure" : "pending";
      return { id: r.id, kind: "refund", status, amount: r.amount, currency: r.currency.toUpperCase() };
    },

    async capture(paymentId, amount, currency): Promise<PaymentTransaction> {
      const pi = await call<StripeIntent>("POST", `/payment_intents/${encodeURIComponent(paymentId)}/capture`, { amount_to_capture: amount });
      return { id: pi.id, kind: "capture", status: pi.status === "succeeded" ? "success" : "pending", amount, currency };
    },

    getPayment,
  };
}

export const stripe: ProviderDefinition<"payment", StripeConfig, StripeSecrets> = {
  id: "stripe",
  kind: "payment",
  displayName: "Stripe",
  description: "Cards, wallets and local payment methods worldwide.",
  docsUrl: "https://docs.stripe.com/keys",
  modes: ["test", "live"],
  configSchema,
  secretsSchema,
  last4Field: "secretKey",
  webhookEvents: ["payment_intent.succeeded", "payment_intent.payment_failed", "payment_intent.canceled", "charge.refunded", "refund.failed"],
  paymentFlow: "widget",
  create: (ctx) => createStripe(ctx),
};
