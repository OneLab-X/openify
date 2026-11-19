import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { errorMessage, header, request } from "../http.js";
import { toMinor } from "../payments/money.js";
import { ProviderError, WebhookSignatureError, type CreateShipmentInput, type ProviderContext, type ProviderDefinition, type RateRequest, type ShipmentParty, type ShippingProvider, type TrackingState } from "../types.js";

/**
 * EasyPost (https://docs.easypost.com). Test and production API keys select the mode. A shipment
 * is created to get rates, then bought at the chosen (or cheapest) rate. Webhooks are signed with
 * HMAC-SHA256 of the raw body in `X-Hmac-Signature: hmac-sha256-hex=<hex>`.
 */
export const EASYPOST_API = "https://api.easypost.com/v2";

const configSchema = z.object({
  carriers: z.array(z.string()).default([]).meta({ title: "Carriers", description: "Limit rates to these carriers (blank = all on your account)" }),
});
const secretsSchema = z.object({
  apiKey: z.string().min(10).meta({ title: "API key", description: "Test key in test mode, production key in live mode" }),
  webhookSecret: z.string().min(8).optional().meta({ title: "Webhook secret" }),
});

interface EpRate {
  id: string;
  carrier: string;
  service: string;
  rate: string;
  currency: string;
  delivery_days?: number | null;
}
interface EpShipment {
  id: string;
  rates: EpRate[];
  tracking_code?: string;
  postage_label?: { label_url?: string; label_pdf_url?: string } | null;
  tracker?: { public_url?: string } | null;
  selected_rate?: EpRate | null;
}

const STATES: Record<string, TrackingState> = {
  unknown: "pending",
  pre_transit: "pending",
  in_transit: "in_transit",
  out_for_delivery: "out_for_delivery",
  delivered: "delivered",
  available_for_pickup: "out_for_delivery",
  return_to_sender: "returned",
  failure: "failed",
  cancelled: "cancelled",
  error: "failed",
};

const address = (p: ShipmentParty) => ({
  name: p.name,
  company: p.company ?? undefined,
  street1: p.line1,
  street2: p.line2 ?? undefined,
  city: p.city,
  state: p.province ?? undefined,
  zip: p.postalCode,
  country: p.country,
  phone: p.phone ?? undefined,
  email: p.email ?? undefined,
});

function create(ctx: ProviderContext<z.infer<typeof configSchema>, z.infer<typeof secretsSchema>>): ShippingProvider {
  const auth = `Basic ${Buffer.from(`${ctx.secrets.apiKey}:`).toString("base64")}`;
  async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await request(`${EASYPOST_API}${path}`, { ...init, headers: { authorization: auth, "content-type": "application/json", ...(init.headers as Record<string, string>) } });
    const body = (await res.json().catch(() => ({}))) as T & { error?: { message?: string } };
    if (!res.ok) throw new ProviderError(body.error?.message ?? `EasyPost error ${res.status}`);
    return body;
  }
  const shipment = (r: RateRequest, reference?: string) =>
    call<EpShipment>("/shipments", {
      method: "POST",
      body: JSON.stringify({
        shipment: {
          reference,
          to_address: address(r.to),
          from_address: address(r.from),
          // EasyPost weights are ounces.
          parcel: { weight: Math.max(0.1, Math.round((r.parcel.weightGrams / 28.3495) * 10) / 10), length: r.parcel.lengthCm ? r.parcel.lengthCm / 2.54 : undefined, width: r.parcel.widthCm ? r.parcel.widthCm / 2.54 : undefined, height: r.parcel.heightCm ? r.parcel.heightCm / 2.54 : undefined },
        },
      }),
    });
  const toRates = (s: EpShipment) =>
    s.rates
      .filter((r) => ctx.config.carriers.length === 0 || ctx.config.carriers.includes(r.carrier))
      .map((r) => ({ id: r.id, name: `${r.carrier} ${r.service}`, carrier: r.carrier, amount: toMinor(r.rate, r.currency), currency: r.currency, ...(r.delivery_days ? { etaDays: r.delivery_days } : {}) }));

  return {
    async testCredentials() {
      try {
        await call("/addresses?page_size=1");
        return { ok: true };
      } catch (err) {
        return { ok: false, error: errorMessage(err) };
      }
    },
    async rates(r) {
      return toRates(await shipment(r));
    },
    async createShipment(input: CreateShipmentInput) {
      const s = await shipment(input, input.reference);
      const rates = toRates(s);
      // Rate ids are per shipment; match a previously quoted rate by carrier + service name.
      const wanted = rates.find((r) => r.id === input.rateId || r.name === input.rateId) ?? [...rates].sort((a, b) => a.amount - b.amount)[0];
      if (!wanted) throw new ProviderError("EasyPost returned no rates for this shipment");
      const bought = await call<EpShipment>(`/shipments/${s.id}/buy`, { method: "POST", body: JSON.stringify({ rate: { id: wanted.id } }) });
      if (!bought.tracking_code) throw new ProviderError("EasyPost did not return a tracking code");
      return {
        shipmentId: bought.id,
        awb: bought.tracking_code,
        carrier: bought.selected_rate?.carrier ?? wanted.carrier,
        labelUrl: bought.postage_label?.label_pdf_url ?? bought.postage_label?.label_url ?? null,
        trackingUrl: bought.tracker?.public_url ?? null,
      };
    },
    async label({ shipmentId }) {
      const s = await call<EpShipment>(`/shipments/${shipmentId}/label?file_format=PDF`);
      return s.postage_label?.label_pdf_url ?? s.postage_label?.label_url ?? null;
    },
    async track(awb) {
      const t = await call<{ status: string; status_detail?: string; tracking_details?: { datetime: string; message: string; tracking_location?: { city?: string } }[] }>("/trackers", {
        method: "POST",
        body: JSON.stringify({ tracker: { tracking_code: awb } }),
      });
      return {
        state: STATES[t.status] ?? "pending",
        description: t.status_detail ?? t.status,
        events: (t.tracking_details ?? []).map((d) => ({ at: d.datetime, description: d.message, location: d.tracking_location?.city ?? null })),
      };
    },
    parseWebhook(raw, headers) {
      if (!ctx.secrets.webhookSecret) return Promise.reject(new WebhookSignatureError("Set the webhook secret first"));
      const sig = header(headers, "x-hmac-signature") ?? "";
      const expected = `hmac-sha256-hex=${createHmac("sha256", ctx.secrets.webhookSecret.normalize("NFKD")).update(raw).digest("hex")}`;
      if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return Promise.reject(new WebhookSignatureError("Bad EasyPost signature"));
      const e = JSON.parse(raw.toString()) as { id: string; description: string; result?: { tracking_code?: string; status?: string; status_detail?: string; updated_at?: string } };
      if (!e.description.startsWith("tracker.") || !e.result?.tracking_code) return Promise.resolve([]);
      return Promise.resolve([
        { id: e.id, awb: e.result.tracking_code, state: STATES[e.result.status ?? ""] ?? "pending", description: e.result.status_detail ?? e.result.status ?? "", at: e.result.updated_at ?? new Date().toISOString() },
      ]);
    },
    trackingUrl: (awb) => `https://www.easypost.com/tracking/${encodeURIComponent(awb)}`,
  };
}

export const easypost: ProviderDefinition<"shipping", z.infer<typeof configSchema>, z.infer<typeof secretsSchema>> = {
  id: "easypost",
  kind: "shipping",
  displayName: "EasyPost",
  description: "USPS, UPS, FedEx, DHL and 100+ carriers through one API.",
  docsUrl: "https://docs.easypost.com",
  modes: ["test", "live"],
  configSchema,
  secretsSchema,
  last4Field: "apiKey",
  webhookEvents: ["tracker.updated"],
  create,
};
