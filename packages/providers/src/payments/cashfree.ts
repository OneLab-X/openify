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
import { assertAmount, toDecimal, toMinor } from "./money.js";

/**
 * Cashfree Payments PG (https://docs.cashfree.com/reference/pg-new-apis-endpoint). The browser
 * opens Cashfree's JS checkout with `payment_session_id`; Cashfree returns to our URL and the
 * signed webhook (HMAC-SHA256 of timestamp + raw body with the client secret) is authoritative.
 */
export const CASHFREE_API = { test: "https://sandbox.cashfree.com/pg", live: "https://api.cashfree.com/pg" } as const;
export const CASHFREE_JS = "https://sdk.cashfree.com/js/v3/cashfree.js";
export const CASHFREE_API_VERSION = "2025-01-01";

const configSchema = z.object({
  clientId: z.string().min(5).meta({ title: "App ID", description: "Developers → API Keys" }),
});
const secretsSchema = z.object({ clientSecret: z.string().min(8).meta({ title: "Secret key" }) });
export type CashfreeConfig = z.infer<typeof configSchema>;
export type CashfreeSecrets = z.infer<typeof secretsSchema>;

interface CfOrder {
  cf_order_id: string | number;
  order_id: string;
  order_amount: number;
  order_currency: string;
  order_status: "ACTIVE" | "PAID" | "EXPIRED" | "TERMINATED" | "TERMINATION_REQUESTED";
  payment_session_id: string;
  order_tags?: Record<string, string> | null;
}
interface CfPayment {
  cf_payment_id: string | number;
  order_id: string;
  payment_status: "SUCCESS" | "NOT_ATTEMPTED" | "FAILED" | "USER_DROPPED" | "VOID" | "CANCELLED" | "PENDING";
  payment_amount: number;
  payment_currency: string;
  payment_group?: string;
  payment_message?: string;
}
interface CfRefund {
  cf_refund_id: string | number;
  refund_id: string;
  order_id: string;
  refund_amount: number;
  refund_currency: string;
  refund_status: "SUCCESS" | "PENDING" | "CANCELLED" | "ONHOLD" | "FAILED";
}

/** Our payment id: Cashfree needs the order id to look a payment up, so both travel together. */
const paymentRef = (orderId: string, paymentId: string | number) => `${orderId}:${paymentId}`;
function parseRef(ref: string): [string, string] {
  const i = ref.lastIndexOf(":");
  if (i <= 0) throw new ProviderError("Unknown Cashfree payment reference");
  return [ref.slice(0, i), ref.slice(i + 1)];
}

function status(p: CfPayment): PaymentStatus {
  switch (p.payment_status) {
    case "SUCCESS":
      return "captured";
    case "FAILED":
    case "USER_DROPPED":
    case "CANCELLED":
    case "VOID":
      return "failed";
    default:
      return "pending";
  }
}

function paymentResult(p: CfPayment, reference: string | null): PaymentResult {
  return {
    status: status(p),
    providerPaymentId: paymentRef(p.order_id, p.cf_payment_id),
    providerOrderId: p.order_id,
    amount: toMinor(p.payment_amount, p.payment_currency),
    amountRefunded: 0,
    currency: p.payment_currency,
    method: p.payment_group ?? null,
    errorDescription: p.payment_status === "SUCCESS" ? null : (p.payment_message ?? null),
    orderReference: reference,
  };
}

/** Cashfree order ids allow 3–45 of [A-Za-z0-9_-]; ours is the UUID without dashes plus an attempt suffix. */
export function cashfreeOrderId(orderId: string, amount: number): string {
  return `sk_${orderId.replace(/-/g, "")}_${amount.toString(36)}`;
}

export function verifyCashfreeSignature(rawBody: Buffer, timestamp: string | undefined, signature: string | undefined, secret: string): void {
  if (!timestamp || !signature) throw new WebhookSignatureError("Missing Cashfree webhook signature headers");
  const expected = createHmac("sha256", secret).update(timestamp).update(rawBody).digest();
  const given = Buffer.from(signature, "base64");
  if (given.length !== expected.length || !timingSafeEqual(expected, given)) throw new WebhookSignatureError("Invalid Cashfree webhook signature");
}

const EVENT_MAP: Record<string, NormalizedWebhookType> = {
  PAYMENT_SUCCESS_WEBHOOK: "payment.captured",
  PAYMENT_FAILED_WEBHOOK: "payment.failed",
  PAYMENT_USER_DROPPED_WEBHOOK: "payment.failed",
  REFUND_STATUS_WEBHOOK: "refund.processed",
};

export function createCashfree(ctx: ProviderContext<CashfreeConfig, CashfreeSecrets>): PaymentProvider {
  const sandbox = ctx.mode === "test" ? ctx.runtime.paymentSandbox : undefined;
  const apiBase = sandbox ? `${sandbox.internalUrl}/cashfree/pg` : CASHFREE_API[ctx.mode];
  const scriptUrl = sandbox ? `${sandbox.publicUrl}/cashfree/cashfree.js` : CASHFREE_JS;

  async function call<T>(method: "GET" | "POST", path: string, body?: unknown, idempotencyKey?: string): Promise<{ status: number; data: T }> {
    const res = await request(`${apiBase}${path}`, {
      method,
      headers: {
        "x-client-id": ctx.config.clientId,
        "x-client-secret": ctx.secrets.clientSecret,
        "x-api-version": CASHFREE_API_VERSION,
        "Content-Type": "application/json",
        ...(idempotencyKey ? { "x-idempotency-key": idempotencyKey } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, data: (await res.json().catch(() => ({}))) as T };
  }
  async function ok<T>(method: "GET" | "POST", path: string, body?: unknown, idempotencyKey?: string): Promise<T> {
    const { status: code, data } = await call<T & { message?: string }>(method, path, body, idempotencyKey);
    if (code >= 400) throw new ProviderError(data.message ?? `Cashfree error (${code})`, code);
    return data;
  }

  async function latestPayment(orderId: string): Promise<CfPayment | null> {
    const payments = await ok<CfPayment[]>("GET", `/orders/${encodeURIComponent(orderId)}/payments`);
    return payments.find((p) => p.payment_status === "SUCCESS") ?? payments.at(-1) ?? null;
  }

  return {
    async testCredentials() {
      try {
        // A missing order is a 404 with valid keys and a 401 with bad ones.
        const { status: code, data } = await call<{ message?: string }>("GET", "/orders/shopkit_credentials_check");
        if (code === 401 || code === 403) return { ok: false, error: data.message ?? "Authentication failed" };
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
      const phone = (customer.phone ?? "").replace(/\D/g, "").slice(-10);
      if (phone.length !== 10) throw new ProviderError("Cashfree needs a 10-digit phone number");
      const cfOrderId = cashfreeOrderId(order.id, amount);
      const url = new URL(returnUrl);
      url.searchParams.set("cf_order_id", "{order_id}");
      const { status: code, data } = await call<CfOrder & { message?: string; code?: string }>("POST", "/orders", {
        order_id: cfOrderId,
        order_amount: Number(toDecimal(amount, currency)),
        order_currency: currency,
        customer_details: {
          customer_id: `c_${order.id.replace(/-/g, "")}`,
          customer_phone: phone,
          ...(customer.email ? { customer_email: customer.email } : {}),
          ...(customer.name ? { customer_name: customer.name.slice(0, 100) } : {}),
        },
        order_meta: { return_url: url.toString().replace("%7Border_id%7D", "{order_id}") },
        order_tags: { shopkit_order: order.id },
      });
      // Same order id + amount → the session already exists; reuse it.
      const cf = code === 409 || data.code === "order_already_exists" ? await ok<CfOrder>("GET", `/orders/${cfOrderId}`) : data;
      if (code >= 400 && code !== 409 && data.code !== "order_already_exists") throw new ProviderError(data.message ?? `Cashfree error (${code})`, code);
      return {
        providerOrderId: cf.order_id,
        clientPayload: { provider: "cashfree", scriptUrl, mode: ctx.mode === "live" ? "production" : "sandbox", paymentSessionId: cf.payment_session_id },
      };
    },

    /** Cashfree returns with `cf_order_id`; the payment is looked up server-to-server. */
    async verifyReturn(payload) {
      const orderId = payload.cf_order_id;
      if (typeof orderId !== "string" || !/^[A-Za-z0-9_-]{3,45}$/.test(orderId)) throw new WebhookSignatureError("Missing Cashfree order id");
      const order = await ok<CfOrder>("GET", `/orders/${encodeURIComponent(orderId)}`);
      const payment = await latestPayment(orderId);
      const reference = order.order_tags?.shopkit_order ?? null;
      if (!payment) {
        return { status: "pending", providerPaymentId: null, providerOrderId: orderId, amount: toMinor(order.order_amount, order.order_currency), amountRefunded: 0, currency: order.order_currency, orderReference: reference };
      }
      return paymentResult(payment, reference);
    },

    async parseWebhook(rawBody, headers) {
      verifyCashfreeSignature(rawBody, header(headers, "x-webhook-timestamp"), header(headers, "x-webhook-signature"), ctx.secrets.clientSecret);
      const event = JSON.parse(rawBody.toString("utf8")) as {
        type: string;
        data: { order?: { order_id: string; order_tags?: Record<string, string> | null }; payment?: Omit<CfPayment, "order_id">; refund?: CfRefund };
      };
      const type = EVENT_MAP[event.type] ?? "unknown";
      const orderId = event.data.order?.order_id ?? event.data.refund?.order_id ?? "";
      const reference = event.data.order?.order_tags?.shopkit_order ?? null;
      const payment = event.data.payment ? paymentResult({ ...event.data.payment, order_id: orderId }, reference) : null;
      const r = event.data.refund;
      const refund = r ? { id: String(r.refund_id), amount: toMinor(r.refund_amount, r.refund_currency), status: r.refund_status === "SUCCESS" ? "processed" : r.refund_status.toLowerCase() } : null;
      // Cashfree has no event id; the object id + status is unique per state change.
      const subject = r ? `refund:${r.cf_refund_id}:${r.refund_status}` : `payment:${event.data.payment?.cf_payment_id}:${event.data.payment?.payment_status}`;
      return {
        id: `${event.type}:${subject}`,
        providerType: event.type,
        type: r && r.refund_status !== "SUCCESS" ? (r.refund_status === "FAILED" || r.refund_status === "CANCELLED" ? "refund.failed" : "unknown") : type,
        payment: payment ?? (r ? { status: "partially_refunded", providerPaymentId: null, providerOrderId: orderId, amount: 0, amountRefunded: refund!.amount, currency: r.refund_currency, orderReference: reference } : null),
        refund,
        raw: event,
      };
    },

    async refund(paymentId, amount, reason, idempotencyKey): Promise<PaymentTransaction> {
      const [orderId] = parseRef(paymentId);
      const order = await ok<CfOrder>("GET", `/orders/${encodeURIComponent(orderId)}`);
      const refundId = (idempotencyKey ?? `${Date.now()}`).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40);
      const r = await ok<CfRefund>(
        "POST",
        `/orders/${encodeURIComponent(orderId)}/refunds`,
        { refund_amount: Number(toDecimal(amount, order.order_currency)), refund_id: refundId, ...(reason ? { refund_note: reason.slice(0, 100) } : {}) },
        idempotencyKey,
      );
      const st = r.refund_status === "SUCCESS" ? "success" : r.refund_status === "FAILED" || r.refund_status === "CANCELLED" ? "failure" : "pending";
      return { id: String(r.refund_id), kind: "refund", status: st, amount: toMinor(r.refund_amount, r.refund_currency), currency: r.refund_currency };
    },

    async getPayment(paymentId) {
      const [orderId, cfPaymentId] = parseRef(paymentId);
      const p = await ok<CfPayment>("GET", `/orders/${encodeURIComponent(orderId)}/payments/${encodeURIComponent(cfPaymentId)}`);
      return paymentResult({ ...p, order_id: orderId }, null);
    },
  };
}

export const cashfree: ProviderDefinition<"payment", CashfreeConfig, CashfreeSecrets> = {
  id: "cashfree",
  kind: "payment",
  displayName: "Cashfree",
  description: "UPI, cards, netbanking and wallets (India).",
  docsUrl: "https://docs.cashfree.com/docs/payment-gateway",
  modes: ["test", "live"],
  configSchema,
  secretsSchema,
  last4Field: "clientSecret",
  webhookEvents: ["PAYMENT_SUCCESS_WEBHOOK", "PAYMENT_FAILED_WEBHOOK", "PAYMENT_USER_DROPPED_WEBHOOK", "REFUND_STATUS_WEBHOOK"],
  paymentFlow: "widget",
  create: createCashfree,
};
