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
 * PayPal Orders v2 (https://developer.paypal.com/docs/api/orders/v2/). The shopper approves on
 * PayPal and comes back with `token` (the PayPal order id); verifyReturn captures it. Webhooks are
 * verified with PayPal's verify-webhook-signature API (needs the webhook id from the dashboard).
 */
export const PAYPAL_API = { test: "https://api-m.sandbox.paypal.com", live: "https://api-m.paypal.com" } as const;

const configSchema = z.object({
  clientId: z.string().min(10).meta({ title: "Client ID", description: "Developer Dashboard → Apps & Credentials" }),
  webhookId: z.string().min(5).optional().meta({ title: "Webhook ID", description: "Shown next to the webhook you add for this shop" }),
});
const secretsSchema = z.object({ clientSecret: z.string().min(10).meta({ title: "Client secret" }) });
export type PayPalConfig = z.infer<typeof configSchema>;
export type PayPalSecrets = z.infer<typeof secretsSchema>;

interface PayPalMoney {
  currency_code: string;
  value: string;
}
interface PayPalCapture {
  id: string;
  status: "COMPLETED" | "DECLINED" | "PARTIALLY_REFUNDED" | "REFUNDED" | "PENDING" | "FAILED";
  amount: PayPalMoney;
  custom_id?: string;
  supplementary_data?: { related_ids?: { order_id?: string } };
  seller_receivable_breakdown?: unknown;
}
interface PayPalOrder {
  id: string;
  status: "CREATED" | "SAVED" | "APPROVED" | "VOIDED" | "COMPLETED" | "PAYER_ACTION_REQUIRED";
  links?: { href: string; rel: string }[];
  purchase_units?: { custom_id?: string; amount?: PayPalMoney; payments?: { captures?: PayPalCapture[]; refunds?: { id: string; amount: PayPalMoney; status: string }[] } }[];
}
interface PayPalRefund {
  id: string;
  status: "CANCELLED" | "FAILED" | "PENDING" | "COMPLETED";
  amount: PayPalMoney;
  links?: { href: string; rel: string }[];
}

function captureStatus(c: PayPalCapture): PaymentStatus {
  switch (c.status) {
    case "COMPLETED":
      return "captured";
    case "PARTIALLY_REFUNDED":
      return "partially_refunded";
    case "REFUNDED":
      return "refunded";
    case "DECLINED":
    case "FAILED":
      return "failed";
    default:
      return "pending";
  }
}

function captureResult(c: PayPalCapture, orderId: string | null, reference: string | null): PaymentResult {
  const currency = c.amount.currency_code;
  return {
    status: captureStatus(c),
    providerPaymentId: c.id,
    providerOrderId: orderId ?? c.supplementary_data?.related_ids?.order_id ?? null,
    amount: toMinor(c.amount.value, currency),
    amountRefunded: c.status === "REFUNDED" ? toMinor(c.amount.value, currency) : 0,
    currency,
    method: "paypal",
    orderReference: c.custom_id ?? reference,
  };
}

function orderResult(o: PayPalOrder): PaymentResult {
  const unit = o.purchase_units?.[0];
  const capture = unit?.payments?.captures?.[0];
  if (capture) {
    const result = captureResult(capture, o.id, unit?.custom_id ?? null);
    const refunded = (unit?.payments?.refunds ?? []).filter((r) => r.status === "COMPLETED").reduce((s, r) => s + toMinor(r.amount.value, r.amount.currency_code), 0);
    if (refunded > 0) {
      result.amountRefunded = refunded;
      result.status = refunded >= result.amount ? "refunded" : "partially_refunded";
    }
    return result;
  }
  const currency = unit?.amount?.currency_code ?? "USD";
  return {
    status: o.status === "VOIDED" ? "failed" : "pending",
    providerPaymentId: null,
    providerOrderId: o.id,
    amount: unit?.amount ? toMinor(unit.amount.value, currency) : 0,
    amountRefunded: 0,
    currency,
    method: "paypal",
    orderReference: unit?.custom_id ?? null,
  };
}

const EVENT_MAP: Record<string, NormalizedWebhookType> = {
  "PAYMENT.CAPTURE.COMPLETED": "payment.captured",
  "PAYMENT.CAPTURE.DENIED": "payment.failed",
  "PAYMENT.CAPTURE.DECLINED": "payment.failed",
  "PAYMENT.CAPTURE.REFUNDED": "refund.processed",
  "PAYMENT.CAPTURE.REVERSED": "refund.processed",
};

export function createPayPal(ctx: ProviderContext<PayPalConfig, PayPalSecrets>): PaymentProvider {
  const sandbox = ctx.mode === "test" ? ctx.runtime.paymentSandbox : undefined;
  const apiBase = sandbox ? `${sandbox.internalUrl}/paypal` : PAYPAL_API[ctx.mode];
  let token: { value: string; expiresAt: number } | null = null;

  async function accessToken(): Promise<string> {
    if (token && token.expiresAt > Date.now() + 60_000) return token.value;
    const res = await request(`${apiBase}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${ctx.config.clientId}:${ctx.secrets.clientSecret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
    });
    const data = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string };
    if (!res.ok || !data.access_token) throw new ProviderError(data.error_description ?? `PayPal authentication failed (${res.status})`, res.status);
    token = { value: data.access_token, expiresAt: Date.now() + (data.expires_in ?? 300) * 1000 };
    return token.value;
  }

  async function call<T>(method: "GET" | "POST", path: string, body?: unknown, requestId?: string): Promise<{ status: number; data: T }> {
    const res = await request(`${apiBase}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${await accessToken()}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
        ...(requestId ? { "PayPal-Request-Id": requestId } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const data = (await res.json().catch(() => ({}))) as T & { message?: string; details?: { issue?: string; description?: string }[] };
    return { status: res.status, data };
  }
  async function ok<T>(method: "GET" | "POST", path: string, body?: unknown, requestId?: string): Promise<T> {
    const { status, data } = await call<T & { message?: string; details?: { description?: string }[] }>(method, path, body, requestId);
    if (status >= 400) throw new ProviderError(data.details?.[0]?.description ?? data.message ?? `PayPal error (${status})`, status);
    return data;
  }

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
      const cancelUrl = new URL(returnUrl);
      cancelUrl.searchParams.set("cancelled", "1");
      const created = await ok<PayPalOrder>(
        "POST",
        "/v2/checkout/orders",
        {
          intent: "CAPTURE",
          purchase_units: [
            {
              reference_id: order.id,
              custom_id: order.id,
              ...(order.number ? { invoice_id: order.number } : {}),
              amount: { currency_code: currency, value: toDecimal(amount, currency) },
            },
          ],
          payment_source: {
            paypal: { experience_context: { return_url: returnUrl, cancel_url: cancelUrl.toString(), user_action: "PAY_NOW", shipping_preference: "NO_SHIPPING" } },
          },
        },
        `shopkit-${order.id}-${amount}-${currency}`,
      );
      const approve = created.links?.find((l) => l.rel === "payer-action" || l.rel === "approve")?.href;
      if (!approve) throw new ProviderError("PayPal did not return an approval link");
      return { providerOrderId: created.id, redirectUrl: approve, clientPayload: { provider: "paypal", redirectUrl: approve } };
    },

    /** PayPal returns with `token` = its order id; capturing is idempotent per order. */
    async verifyReturn(payload) {
      const orderId = payload.token;
      if (typeof orderId !== "string" || !/^[A-Z0-9]{8,40}$/.test(orderId)) throw new WebhookSignatureError("Missing PayPal order token");
      const { status, data } = await call<PayPalOrder & { details?: { issue?: string }[] }>("POST", `/v2/checkout/orders/${orderId}/capture`, {}, `shopkit-capture-${orderId}`);
      if (status < 400) return orderResult(data);
      if (data.details?.some((d) => d.issue === "ORDER_ALREADY_CAPTURED") || status === 422) {
        return orderResult(await ok<PayPalOrder>("GET", `/v2/checkout/orders/${orderId}`));
      }
      throw new ProviderError(`PayPal capture failed (${status})`, status);
    },

    async parseWebhook(rawBody, headers) {
      const webhookId = ctx.config.webhookId;
      if (!webhookId) throw new WebhookSignatureError("PayPal webhook id is not configured");
      let event: { id: string; event_type: string; resource: Record<string, unknown> };
      try {
        event = JSON.parse(rawBody.toString("utf8")) as typeof event;
      } catch {
        throw new WebhookSignatureError("Invalid PayPal webhook body");
      }
      const h = (n: string) => header(headers, n);
      const verification = await ok<{ verification_status: string }>("POST", "/v1/notifications/verify-webhook-signature", {
        auth_algo: h("paypal-auth-algo"),
        cert_url: h("paypal-cert-url"),
        transmission_id: h("paypal-transmission-id"),
        transmission_sig: h("paypal-transmission-sig"),
        transmission_time: h("paypal-transmission-time"),
        webhook_id: webhookId,
        webhook_event: event,
      });
      if (verification.verification_status !== "SUCCESS") throw new WebhookSignatureError("Invalid PayPal webhook signature");
      const type = EVENT_MAP[event.event_type] ?? "unknown";
      let payment: PaymentResult | null = null;
      let refund: { id: string; amount: number; status: string } | null = null;
      if (event.event_type.startsWith("PAYMENT.CAPTURE.") && type !== "refund.processed") {
        payment = captureResult(event.resource as unknown as PayPalCapture, null, null);
      } else if (type === "refund.processed") {
        const r = event.resource as unknown as PayPalRefund & { custom_id?: string };
        const captureId = r.links?.find((l) => l.rel === "up")?.href.split("/").pop() ?? null;
        const amount = toMinor(r.amount.value, r.amount.currency_code);
        refund = { id: r.id, amount, status: r.status === "COMPLETED" ? "processed" : r.status.toLowerCase() };
        payment = {
          status: "partially_refunded",
          providerPaymentId: captureId,
          providerOrderId: null,
          amount: 0,
          amountRefunded: amount,
          currency: r.amount.currency_code,
          method: "paypal",
          orderReference: r.custom_id ?? null,
        };
      }
      return { id: event.id, providerType: event.event_type, type, payment, refund, raw: event };
    },

    async refund(paymentId, amount, reason, idempotencyKey): Promise<PaymentTransaction> {
      const capture = await ok<PayPalCapture>("GET", `/v2/payments/captures/${encodeURIComponent(paymentId)}`);
      const currency = capture.amount.currency_code;
      const r = await ok<PayPalRefund>(
        "POST",
        `/v2/payments/captures/${encodeURIComponent(paymentId)}/refund`,
        { amount: { currency_code: currency, value: toDecimal(amount, currency) }, ...(reason ? { note_to_payer: reason.slice(0, 255) } : {}) },
        idempotencyKey ? `shopkit-refund-${idempotencyKey}` : undefined,
      );
      const status = r.status === "COMPLETED" ? "success" : r.status === "PENDING" ? "pending" : "failure";
      return { id: r.id, kind: "refund", status, amount: toMinor(r.amount.value, currency), currency };
    },

    async getPayment(paymentId) {
      return captureResult(await ok<PayPalCapture>("GET", `/v2/payments/captures/${encodeURIComponent(paymentId)}`), null, null);
    },
  };
}

export const paypal: ProviderDefinition<"payment", PayPalConfig, PayPalSecrets> = {
  id: "paypal",
  kind: "payment",
  displayName: "PayPal",
  description: "PayPal balance, cards and Pay Later.",
  docsUrl: "https://developer.paypal.com/api/rest/",
  modes: ["test", "live"],
  configSchema,
  secretsSchema,
  last4Field: "clientSecret",
  webhookEvents: ["PAYMENT.CAPTURE.COMPLETED", "PAYMENT.CAPTURE.DENIED", "PAYMENT.CAPTURE.REFUNDED", "PAYMENT.CAPTURE.REVERSED"],
  paymentFlow: "redirect",
  create: createPayPal,
};
