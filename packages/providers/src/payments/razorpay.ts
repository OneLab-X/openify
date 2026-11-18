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

/**
 * Razorpay (https://razorpay.com/docs/api/). Ported from PrettyLittleStore: the browser never
 * sends an amount, our order id is the Razorpay `receipt` and in `notes.orderId`, the client
 * return is a fast path, and the webhook (raw-body HMAC) is the source of truth.
 */
export const RAZORPAY_API = "https://api.razorpay.com/v1";

const configSchema = z.object({
  keyId: z
    .string()
    .regex(/^rzp_(test|live)_[A-Za-z0-9]+$/, "Key ID looks like rzp_test_… or rzp_live_…")
    .meta({ title: "Key ID", description: "Dashboard → Account & Settings → API Keys" }),
});
const secretsSchema = z.object({
  keySecret: z.string().min(8).meta({ title: "Key secret" }),
  webhookSecret: z
    .string()
    .min(8)
    .optional()
    .meta({ title: "Webhook secret", description: "Set when you create the webhook in the Razorpay dashboard" }),
});
export type RazorpayConfig = z.infer<typeof configSchema>;
export type RazorpaySecrets = z.infer<typeof secretsSchema>;

interface RzpPayment {
  id: string;
  order_id: string | null;
  amount: number;
  amount_refunded: number;
  currency: string;
  status: "created" | "authorized" | "captured" | "refunded" | "failed";
  method?: string;
  error_description?: string | null;
  notes?: Record<string, string> | unknown[];
}
interface RzpOrder {
  id: string;
  amount: number;
  currency: string;
  receipt: string | null;
  status: string;
}
interface RzpRefund {
  id: string;
  payment_id: string;
  amount: number;
  currency: string;
  status: "pending" | "processed" | "failed";
}

function hmacMatches(payload: string | Buffer, secret: string, signature: unknown): boolean {
  if (typeof signature !== "string" || !/^[0-9a-f]{64}$/i.test(signature)) return false;
  const expected = createHmac("sha256", secret).update(payload).digest();
  return timingSafeEqual(expected, Buffer.from(signature, "hex"));
}

function paymentStatus(p: RzpPayment): PaymentStatus {
  if (p.amount_refunded > 0) return p.amount_refunded >= p.amount ? "refunded" : "partially_refunded";
  switch (p.status) {
    case "authorized":
      return "authorized";
    case "captured":
      return "captured";
    case "failed":
      return "failed";
    case "refunded":
      return "refunded";
    default:
      return "pending";
  }
}

function toResult(p: RzpPayment): PaymentResult {
  const notes = p.notes && !Array.isArray(p.notes) ? p.notes : {};
  return {
    status: paymentStatus(p),
    providerPaymentId: p.id,
    providerOrderId: p.order_id,
    amount: p.amount,
    amountRefunded: p.amount_refunded,
    currency: p.currency,
    method: p.method ?? null,
    errorDescription: p.error_description ?? null,
    orderReference: (notes).orderId ?? null,
  };
}

const EVENT_MAP: Record<string, NormalizedWebhookType> = {
  "payment.authorized": "payment.authorized",
  "payment.captured": "payment.captured",
  "order.paid": "payment.captured",
  "payment.failed": "payment.failed",
  "refund.processed": "refund.processed",
  "refund.failed": "refund.failed",
};

export function createRazorpay(ctx: ProviderContext<RazorpayConfig, RazorpaySecrets>): PaymentProvider {
  const { keyId } = ctx.config;
  const auth = `Basic ${Buffer.from(`${keyId}:${ctx.secrets.keySecret}`).toString("base64")}`;

  async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const res = await request(`${RAZORPAY_API}${path}`, {
      method,
      headers: { Authorization: auth, ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const data = (await res.json().catch(() => ({}))) as { error?: { description?: string } } & T;
    if (!res.ok) throw new ProviderError(data.error?.description ?? `Razorpay error (${res.status})`, res.status);
    return data;
  }

  function assertModeMatchesKey() {
    const keyMode = keyId.startsWith("rzp_live_") ? "live" : "test";
    if (keyMode !== ctx.mode) {
      throw new ProviderError(`This is a ${keyMode} key but the credential is for ${ctx.mode} mode`);
    }
  }

  const getPayment = async (paymentId: string) =>
    toResult(await call<RzpPayment>("GET", `/payments/${encodeURIComponent(paymentId)}`));

  return {
    async testCredentials() {
      try {
        assertModeMatchesKey();
        await call("GET", "/orders?count=1");
        return { ok: true };
      } catch (err) {
        return { ok: false, error: errorMessage(err) };
      }
    },

    async createSession({ order, amount, currency, customer }) {
      if (!Number.isInteger(amount) || amount <= 0) throw new ProviderError("Amount must be a positive integer");
      const rzp = await call<RzpOrder>("POST", "/orders", {
        amount,
        currency,
        receipt: order.id,
        notes: { orderId: order.id, ...(order.number ? { orderNumber: order.number } : {}) },
      });
      return {
        providerOrderId: rzp.id,
        clientPayload: {
          provider: "razorpay",
          keyId,
          orderId: rzp.id,
          amount: rzp.amount,
          currency: rzp.currency,
          prefill: { name: customer.name, email: customer.email, contact: customer.phone },
          notes: { orderId: order.id },
        },
      };
    },

    async verifyReturn(payload) {
      const orderId = payload.razorpay_order_id;
      const paymentId = payload.razorpay_payment_id;
      if (typeof orderId !== "string" || typeof paymentId !== "string") {
        throw new WebhookSignatureError("Missing Razorpay return fields");
      }
      if (!hmacMatches(`${orderId}|${paymentId}`, ctx.secrets.keySecret, payload.razorpay_signature)) {
        throw new WebhookSignatureError("Invalid Razorpay checkout signature");
      }
      const result = await getPayment(paymentId);
      if (result.providerOrderId !== orderId) throw new WebhookSignatureError("Payment does not belong to order");
      return result;
    },

    // Signature is checked on the exact raw bytes before anything is parsed.
    // eslint-disable-next-line @typescript-eslint/require-await
    async parseWebhook(rawBody, headers) {
      const secret = ctx.secrets.webhookSecret;
      if (!secret) throw new WebhookSignatureError("Razorpay webhook secret is not configured");
      if (!hmacMatches(rawBody, secret, header(headers, "x-razorpay-signature"))) {
        throw new WebhookSignatureError("Invalid Razorpay webhook signature");
      }
      const eventId = header(headers, "x-razorpay-event-id");
      if (!eventId) throw new WebhookSignatureError("Missing x-razorpay-event-id");
      const body = JSON.parse(rawBody.toString("utf8")) as {
        event: string;
        payload: { payment?: { entity: RzpPayment }; refund?: { entity: RzpRefund } };
      };
      const payment = body.payload.payment?.entity;
      const refund = body.payload.refund?.entity;
      return {
        id: eventId,
        providerType: body.event,
        type: EVENT_MAP[body.event] ?? "unknown",
        payment: payment ? toResult(payment) : null,
        refund: refund ? { id: refund.id, amount: refund.amount, status: refund.status } : null,
        raw: body,
      };
    },

    async capture(paymentId, amount, currency): Promise<PaymentTransaction> {
      const p = await call<RzpPayment>("POST", `/payments/${encodeURIComponent(paymentId)}/capture`, {
        amount,
        currency,
      });
      return { id: p.id, kind: "capture", status: p.status === "captured" ? "success" : "pending", amount, currency };
    },

    async refund(paymentId, amount, reason): Promise<PaymentTransaction> {
      const r = await call<RzpRefund>("POST", `/payments/${encodeURIComponent(paymentId)}/refund`, {
        amount,
        speed: "normal",
        notes: reason ? { reason } : {},
      });
      const status = r.status === "processed" ? "success" : r.status === "failed" ? "failure" : "pending";
      return { id: r.id, kind: "refund", status, amount: r.amount, currency: r.currency };
    },

    getPayment,
  };
}

export const razorpay: ProviderDefinition<"payment", RazorpayConfig, RazorpaySecrets> = {
  id: "razorpay",
  kind: "payment",
  displayName: "Razorpay",
  description: "Cards, UPI, netbanking and wallets (India).",
  docsUrl: "https://razorpay.com/docs/payments/dashboard/account-settings/api-keys/",
  modes: ["test", "live"],
  configSchema,
  secretsSchema,
  last4Field: "keySecret",
  webhookEvents: ["payment.captured", "payment.failed", "order.paid", "refund.processed", "refund.failed"],
  create: createRazorpay,
};
