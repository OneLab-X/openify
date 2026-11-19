import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
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
 * PhonePe PG Standard Checkout v2 (https://developer.phonepe.com/v1/reference/pay-api-v2). The
 * shopper is redirected to PhonePe and back to our URL without parameters, so verifyReturn looks
 * the order up server-to-server by the merchant order id that core stored at session time.
 * Callbacks carry `Authorization: SHA256(username:password)` set in the PhonePe dashboard.
 */
export const PHONEPE_API = {
  test: { auth: "https://api-preprod.phonepe.com/apis/pg-sandbox", pg: "https://api-preprod.phonepe.com/apis/pg-sandbox" },
  live: { auth: "https://api.phonepe.com/apis/identity-manager", pg: "https://api.phonepe.com/apis/pg" },
} as const;

const configSchema = z.object({
  clientId: z.string().min(3).meta({ title: "Client ID" }),
  clientVersion: z.number().int().min(1).default(1).meta({ title: "Client version" }),
  webhookUsername: z.string().min(3).optional().meta({ title: "Webhook username", description: "Set when you configure the webhook in the PhonePe dashboard" }),
});
const secretsSchema = z.object({
  clientSecret: z.string().min(8).meta({ title: "Client secret" }),
  webhookPassword: z.string().min(3).optional().meta({ title: "Webhook password" }),
});
export type PhonePeConfig = z.infer<typeof configSchema>;
export type PhonePeSecrets = z.infer<typeof secretsSchema>;

interface PpOrderStatus {
  orderId: string;
  state: "PENDING" | "COMPLETED" | "FAILED";
  amount: number;
  metaInfo?: Record<string, string>;
  errorCode?: string;
  detailedErrorCode?: string;
  paymentDetails?: { transactionId: string; paymentMode?: string; amount: number; state: string; errorCode?: string }[];
}

function result(merchantOrderId: string, s: PpOrderStatus): PaymentResult {
  const state: PaymentStatus = s.state === "COMPLETED" ? "captured" : s.state === "FAILED" ? "failed" : "pending";
  const last = s.paymentDetails?.at(-1);
  return {
    status: state,
    providerPaymentId: merchantOrderId,
    providerOrderId: merchantOrderId,
    amount: s.amount,
    amountRefunded: 0,
    currency: "INR",
    method: last?.paymentMode ?? null,
    errorDescription: s.state === "FAILED" ? (s.detailedErrorCode ?? s.errorCode ?? last?.errorCode ?? "Payment failed") : null,
    orderReference: s.metaInfo?.udf1 ?? null,
  };
}

const EVENT_MAP: Record<string, NormalizedWebhookType> = {
  "checkout.order.completed": "payment.captured",
  "checkout.order.failed": "payment.failed",
  "pg.refund.completed": "refund.processed",
  "pg.refund.failed": "refund.failed",
};

export function createPhonePe(ctx: ProviderContext<PhonePeConfig, PhonePeSecrets>): PaymentProvider {
  const sandbox = ctx.mode === "test" ? ctx.runtime.paymentSandbox : undefined;
  const base = sandbox ? { auth: `${sandbox.internalUrl}/phonepe`, pg: `${sandbox.internalUrl}/phonepe` } : PHONEPE_API[ctx.mode];
  let token: { value: string; expiresAt: number } | null = null;

  async function accessToken(): Promise<string> {
    if (token && token.expiresAt > Date.now() + 60_000) return token.value;
    const res = await request(`${base.auth}/v1/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: ctx.config.clientId,
        client_version: String(ctx.config.clientVersion ?? 1),
        client_secret: ctx.secrets.clientSecret,
        grant_type: "client_credentials",
      }).toString(),
    });
    const data = (await res.json().catch(() => ({}))) as { access_token?: string; expires_at?: number; message?: string };
    if (!res.ok || !data.access_token) throw new ProviderError(data.message ?? `PhonePe authentication failed (${res.status})`, res.status);
    token = { value: data.access_token, expiresAt: data.expires_at ? data.expires_at * 1000 : Date.now() + 600_000 };
    return token.value;
  }

  async function call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const res = await request(`${base.pg}${path}`, {
      method,
      headers: { Authorization: `O-Bearer ${await accessToken()}`, "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const data = (await res.json().catch(() => ({}))) as T & { message?: string };
    if (!res.ok) throw new ProviderError(data.message ?? `PhonePe error (${res.status})`, res.status);
    return data;
  }

  const status = async (merchantOrderId: string) =>
    result(merchantOrderId, await call<PpOrderStatus>("GET", `/checkout/v2/order/${encodeURIComponent(merchantOrderId)}/status?details=true`));

  return {
    async testCredentials() {
      try {
        await accessToken();
        return { ok: true };
      } catch (err) {
        return { ok: false, error: errorMessage(err) };
      }
    },

    async createSession({ order, amount, currency, returnUrl }) {
      try {
        assertAmount(amount);
      } catch (err) {
        throw new ProviderError(errorMessage(err));
      }
      if (currency !== "INR") throw new ProviderError("PhonePe only accepts INR");
      // PhonePe rejects a reused merchantOrderId, so every session gets a fresh suffix (≤ 63 chars).
      const merchantOrderId = `${order.id.replace(/-/g, "")}_${randomBytes(4).toString("hex")}`;
      const res = await call<{ orderId: string; state: string; redirectUrl: string }>("POST", "/checkout/v2/pay", {
        merchantOrderId,
        amount,
        expireAfter: 1800,
        metaInfo: { udf1: order.id, ...(order.number ? { udf2: order.number } : {}) },
        paymentFlow: { type: "PG_CHECKOUT", merchantUrls: { redirectUrl: returnUrl } },
      });
      return { providerOrderId: merchantOrderId, redirectUrl: res.redirectUrl, clientPayload: { provider: "phonepe", redirectUrl: res.redirectUrl } };
    },

    /** PhonePe's return carries nothing; core passes the stored merchant order id. */
    async verifyReturn(payload) {
      const merchantOrderId = payload.merchantOrderId;
      if (typeof merchantOrderId !== "string" || !/^[A-Za-z0-9_-]{1,63}$/.test(merchantOrderId)) throw new WebhookSignatureError("Missing PhonePe merchant order id");
      return status(merchantOrderId);
    },

    async parseWebhook(rawBody, headers) {
      const { webhookUsername } = ctx.config;
      const password = ctx.secrets.webhookPassword;
      if (!webhookUsername || !password) throw new WebhookSignatureError("PhonePe webhook credentials are not configured");
      const expected = createHash("sha256").update(`${webhookUsername}:${password}`).digest();
      const given = (header(headers, "authorization") ?? "").replace(/^SHA256\s+/i, "").trim();
      if (!/^[0-9a-f]{64}$/i.test(given) || !timingSafeEqual(expected, Buffer.from(given, "hex"))) {
        throw new WebhookSignatureError("Invalid PhonePe webhook authorization");
      }
      const event = JSON.parse(rawBody.toString("utf8")) as {
        event: string;
        payload: PpOrderStatus & { merchantOrderId?: string; merchantRefundId?: string; refundId?: string; originalMerchantOrderId?: string };
      };
      const p = event.payload;
      const type = EVENT_MAP[event.event] ?? "unknown";
      const isRefund = event.event.startsWith("pg.refund.");
      const merchantOrderId = (isRefund ? p.originalMerchantOrderId : p.merchantOrderId) ?? "";
      return {
        // PhonePe sends no event id; the PhonePe order/refund id + state is unique per transition.
        id: `${event.event}:${isRefund ? p.refundId : p.orderId}:${p.state}`,
        providerType: event.event,
        type,
        payment: isRefund
          ? { status: "partially_refunded", providerPaymentId: merchantOrderId, providerOrderId: merchantOrderId, amount: 0, amountRefunded: p.amount, currency: "INR", orderReference: null }
          : result(merchantOrderId, p),
        refund: isRefund ? { id: p.merchantRefundId ?? p.refundId ?? "", amount: p.amount, status: p.state === "COMPLETED" ? "processed" : p.state.toLowerCase() } : null,
        raw: event,
      };
    },

    async refund(paymentId, amount, _reason, idempotencyKey): Promise<PaymentTransaction> {
      const merchantRefundId = (idempotencyKey ?? randomBytes(8).toString("hex")).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 63);
      const r = await call<{ refundId: string; amount: number; state: "PENDING" | "COMPLETED" | "FAILED" | "CONFIRMED" }>("POST", "/payments/v2/refund", {
        merchantRefundId,
        originalMerchantOrderId: paymentId,
        amount,
      });
      const st = r.state === "COMPLETED" ? "success" : r.state === "FAILED" ? "failure" : "pending";
      return { id: merchantRefundId, kind: "refund", status: st, amount: r.amount, currency: "INR" };
    },

    getPayment: status,
  };
}

export const phonepe: ProviderDefinition<"payment", PhonePeConfig, PhonePeSecrets> = {
  id: "phonepe",
  kind: "payment",
  displayName: "PhonePe",
  description: "UPI, cards and netbanking via PhonePe (India).",
  docsUrl: "https://developer.phonepe.com/v1/docs/standard-checkout",
  modes: ["test", "live"],
  configSchema,
  secretsSchema,
  last4Field: "clientSecret",
  webhookEvents: ["checkout.order.completed", "checkout.order.failed", "pg.refund.completed", "pg.refund.failed"],
  paymentFlow: "redirect",
  create: createPhonePe,
};
