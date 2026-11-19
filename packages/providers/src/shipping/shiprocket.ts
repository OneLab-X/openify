import { z } from "zod";
import { errorMessage, request } from "../http.js";
import { toDecimal, toMinor } from "../payments/money.js";
import { ProviderError, type CreateShipmentInput, type ProviderContext, type ProviderDefinition, type RateRequest, type ShippingProvider, type TrackingWebhookEvent } from "../types.js";
import { first, kg, requireToken, stateFromText } from "./shared.js";

/**
 * Shiprocket (https://apidocs.shiprocket.in). One API for both modes; "test" only labels the
 * credentials. Auth is an email/password API user that returns a bearer token (cached ~9 days).
 * Webhooks: Shiprocket sends the token configured in its dashboard in `x-api-key`.
 */
export const SHIPROCKET_API = "https://apiv2.shiprocket.in/v1/external";

const configSchema = z.object({
  email: z.email().meta({ title: "API user email", description: "Settings → API → Create an API user" }),
  pickupLocation: z.string().min(1).meta({ title: "Pickup location name", description: "Exactly as in Shiprocket → Settings → Pickup addresses" }),
});
const secretsSchema = z.object({
  password: z.string().min(4).meta({ title: "API user password" }),
  webhookToken: z.string().min(8).optional().meta({ title: "Webhook token", description: "Set the same value as the token in Shiprocket → Settings → Webhooks" }),
});

interface Courier {
  courier_company_id: number;
  courier_name: string;
  rate: number;
  estimated_delivery_days?: string | number;
}

function create(ctx: ProviderContext<z.infer<typeof configSchema>, z.infer<typeof secretsSchema>>): ShippingProvider {
  let token: { value: string; expires: number } | null = null;

  async function auth(): Promise<string> {
    if (token && token.expires > Date.now()) return token.value;
    const res = await request(`${SHIPROCKET_API}/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: ctx.config.email, password: ctx.secrets.password }),
    });
    const body = (await res.json().catch(() => ({}))) as { token?: string; message?: string };
    if (!res.ok || !body.token) throw new ProviderError(body.message ?? `Shiprocket login failed (${res.status})`);
    token = { value: body.token, expires: Date.now() + 9 * 24 * 3600 * 1000 };
    return token.value;
  }

  async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await request(`${SHIPROCKET_API}${path}`, {
      ...init,
      headers: { "content-type": "application/json", authorization: `Bearer ${await auth()}`, ...(init.headers as Record<string, string>) },
    });
    const body = (await res.json().catch(() => ({}))) as T & { message?: string };
    if (!res.ok) throw new ProviderError(body.message ?? `Shiprocket error ${res.status}`);
    return body;
  }

  const rates = async (r: RateRequest) => {
    const q = new URLSearchParams({
      pickup_postcode: r.from.postalCode,
      delivery_postcode: r.to.postalCode,
      weight: String(kg(r.parcel.weightGrams)),
      cod: r.codAmount ? "1" : "0",
      declared_value: toDecimal(r.declaredValue, r.currency),
    });
    const body = await call<{ data?: { available_courier_companies?: Courier[] } }>(`/courier/serviceability/?${q}`);
    return (body.data?.available_courier_companies ?? []).map((c) => ({
      id: String(c.courier_company_id),
      name: c.courier_name,
      carrier: c.courier_name,
      amount: toMinor(c.rate, "INR"),
      currency: "INR",
      ...(c.estimated_delivery_days ? { etaDays: Number(c.estimated_delivery_days) } : {}),
    }));
  };

  return {
    async testCredentials() {
      try {
        token = null;
        await auth();
        return { ok: true };
      } catch (err) {
        return { ok: false, error: errorMessage(err) };
      }
    },
    rates,
    async createShipment(input: CreateShipmentInput) {
      const [firstName, ...rest] = input.to.name.split(" ");
      const order = await call<{ order_id: number; shipment_id: number }>("/orders/create/adhoc", {
        method: "POST",
        body: JSON.stringify({
          order_id: input.reference,
          order_date: input.orderDate.slice(0, 16).replace("T", " "),
          pickup_location: ctx.config.pickupLocation,
          billing_customer_name: firstName,
          billing_last_name: rest.join(" "),
          billing_address: input.to.line1,
          billing_address_2: input.to.line2 ?? "",
          billing_city: input.to.city,
          billing_pincode: input.to.postalCode,
          billing_state: input.to.province ?? "",
          billing_country: input.to.country === "IN" ? "India" : input.to.country,
          billing_email: input.to.email ?? "",
          billing_phone: input.to.phone ?? "",
          shipping_is_billing: true,
          order_items: input.items.map((i) => ({ name: i.name, sku: i.sku ?? i.name.slice(0, 40), units: i.quantity, selling_price: toDecimal(i.unitPrice, input.currency), hsn: i.hsnCode ?? "" })),
          payment_method: input.codAmount ? "COD" : "Prepaid",
          sub_total: toDecimal(input.declaredValue, input.currency),
          length: input.parcel.lengthCm ?? 10,
          breadth: input.parcel.widthCm ?? 10,
          height: input.parcel.heightCm ?? 5,
          weight: kg(input.parcel.weightGrams),
        }),
      });
      const courierId = input.rateId ?? first(await rates(input), (r) => r.amount)?.id;
      const awb = await call<{ awb_assign_status?: number; response?: { data?: { awb_code?: string; courier_name?: string } }; message?: string }>("/courier/assign/awb", {
        method: "POST",
        body: JSON.stringify({ shipment_id: order.shipment_id, ...(courierId ? { courier_id: Number(courierId) } : {}) }),
      });
      const code = awb.response?.data?.awb_code;
      if (!code) throw new ProviderError(awb.message ?? "Shiprocket did not assign an AWB");
      const shipmentId = String(order.shipment_id);
      return {
        shipmentId,
        awb: code,
        carrier: awb.response?.data?.courier_name ?? "Shiprocket",
        labelUrl: await this.label({ shipmentId, awb: code }),
        trackingUrl: `https://shiprocket.co/tracking/${encodeURIComponent(code)}`,
      };
    },
    async label({ shipmentId }) {
      const body = await call<{ label_url?: string; label_created?: number }>("/courier/generate/label", { method: "POST", body: JSON.stringify({ shipment_id: [Number(shipmentId)] }) });
      return body.label_url ?? null;
    },
    async track(awb) {
      const body = await call<{ tracking_data?: { shipment_status?: number; shipment_track?: { current_status?: string }[]; shipment_track_activities?: { date: string; activity: string; location?: string }[] } }>(
        `/courier/track/awb/${encodeURIComponent(awb)}`,
      );
      const current = body.tracking_data?.shipment_track?.[0]?.current_status ?? "Pending";
      return {
        state: stateFromText(current),
        description: current,
        events: (body.tracking_data?.shipment_track_activities ?? []).map((a) => ({ at: a.date, description: a.activity, location: a.location ?? null })),
      };
    },
    parseWebhook(raw, headers) {
      try {
        requireToken(headers, "x-api-key", ctx.secrets.webhookToken);
      } catch (err) {
        return Promise.reject(err instanceof Error ? err : new Error(String(err)));
      }
      const b = JSON.parse(raw.toString()) as { awb?: string | number; current_status?: string; shipment_status?: string; current_status_id?: number; current_timestamp?: string; scans?: unknown[] };
      if (!b.awb) return Promise.resolve([]);
      const status = b.current_status ?? b.shipment_status ?? "";
      const at = b.current_timestamp ?? new Date().toISOString();
      const event: TrackingWebhookEvent = { id: `${b.awb}:${b.current_status_id ?? status}:${at}`, awb: String(b.awb), state: stateFromText(status), description: status, at };
      return Promise.resolve([event]);
    },
    trackingUrl: (awb) => `https://shiprocket.co/tracking/${encodeURIComponent(awb)}`,
  };
}

export const shiprocket: ProviderDefinition<"shipping", z.infer<typeof configSchema>, z.infer<typeof secretsSchema>> = {
  id: "shiprocket",
  kind: "shipping",
  displayName: "Shiprocket",
  description: "Rates from 25+ Indian couriers, AWBs, labels and tracking.",
  docsUrl: "https://apidocs.shiprocket.in",
  modes: ["live"],
  configSchema,
  secretsSchema,
  webhookEvents: ["Shipment status updates"],
  create,
};
