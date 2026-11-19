import { z } from "zod";
import { errorMessage, request } from "../http.js";
import { toDecimal, toMinor } from "../payments/money.js";
import { ProviderError, type CreateShipmentInput, type ProviderContext, type ProviderDefinition, type ShippingProvider, type TrackingWebhookEvent } from "../types.js";
import { requireToken, stateFromText } from "./shared.js";

/**
 * Delhivery B2C (https://one.delhivery.com/developer-portal). Token auth; staging in test mode.
 * Shipments are created with a pre-assigned waybill, labels come from the packing-slip API, and
 * tracking pushes carry the token agreed with Delhivery in `x-delhivery-token`.
 */
export const DELHIVERY_API = { live: "https://track.delhivery.com", test: "https://staging-express.dlv.api.delhivery.com" } as const;
export const delhiveryTrackingUrl = (awb: string) => `https://www.delhivery.com/track/package/${encodeURIComponent(awb)}`;

const configSchema = z.object({
  pickupLocation: z.string().min(1).meta({ title: "Pickup location (warehouse) name", description: "As registered with Delhivery" }),
  serviceMode: z.enum(["E", "S"]).default("S").meta({ title: "Service", description: "S = surface, E = express" }),
});
const secretsSchema = z.object({
  apiToken: z.string().min(10).meta({ title: "API token" }),
  webhookToken: z.string().min(8).optional().meta({ title: "Webhook token", description: "Shared with Delhivery for status pushes" }),
});

interface DlvScan {
  ScanDetail: { Scan: string; ScanDateTime: string; ScannedLocation?: string; Instructions?: string };
}

function create(ctx: ProviderContext<z.infer<typeof configSchema>, z.infer<typeof secretsSchema>>): ShippingProvider {
  const base = DELHIVERY_API[ctx.mode];
  const headers = { authorization: `Token ${ctx.secrets.apiToken}`, accept: "application/json" };

  async function get<T>(path: string): Promise<T> {
    const res = await request(`${base}${path}`, { headers });
    const body = (await res.json().catch(() => ({}))) as T & { error?: string; detail?: string };
    if (!res.ok) throw new ProviderError(body.error ?? body.detail ?? `Delhivery error ${res.status}`);
    return body;
  }

  return {
    async testCredentials() {
      try {
        await get(`/c/api/pin-codes/json/?filter_codes=110001`);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: errorMessage(err) };
      }
    },
    async rates(r) {
      const q = new URLSearchParams({ md: ctx.config.serviceMode, ss: "Delivered", d_pin: r.to.postalCode, o_pin: r.from.postalCode, cgm: String(Math.max(1, Math.round(r.parcel.weightGrams))), pt: r.codAmount ? "COD" : "Pre-paid" });
      const rows = await get<{ total_amount: number }[]>(`/api/kinko/v1/invoice/charges/.json?${q}`);
      return rows.map((row, i) => ({ id: `${ctx.config.serviceMode}${i}`, name: ctx.config.serviceMode === "E" ? "Delhivery Express" : "Delhivery Surface", carrier: "Delhivery", amount: toMinor(row.total_amount, "INR"), currency: "INR" }));
    },
    async createShipment(input: CreateShipmentInput) {
      const shipment = {
        name: input.to.name,
        add: [input.to.line1, input.to.line2].filter(Boolean).join(", "),
        pin: input.to.postalCode,
        city: input.to.city,
        state: input.to.province ?? "",
        country: "India",
        phone: input.to.phone ?? "",
        order: input.reference,
        payment_mode: input.codAmount ? "COD" : "Prepaid",
        cod_amount: input.codAmount ? toDecimal(input.codAmount, input.currency) : "0",
        total_amount: toDecimal(input.declaredValue, input.currency),
        products_desc: input.items.map((i) => `${i.name} x${i.quantity}`).join(", ").slice(0, 200),
        hsn_code: input.items.find((i) => i.hsnCode)?.hsnCode ?? "",
        quantity: String(input.items.reduce((s, i) => s + i.quantity, 0)),
        weight: String(Math.max(1, Math.round(input.parcel.weightGrams))),
        shipment_length: input.parcel.lengthCm ?? "",
        shipment_width: input.parcel.widthCm ?? "",
        shipment_height: input.parcel.heightCm ?? "",
        shipping_mode: ctx.config.serviceMode === "E" ? "Express" : "Surface",
        order_date: input.orderDate,
      };
      const body = `format=json&data=${encodeURIComponent(JSON.stringify({ shipments: [shipment], pickup_location: { name: ctx.config.pickupLocation } }))}`;
      const res = await request(`${base}/api/cmu/create.json`, { method: "POST", headers: { ...headers, "content-type": "application/x-www-form-urlencoded" }, body });
      const out = (await res.json().catch(() => ({}))) as { success?: boolean; rmk?: string; packages?: { waybill: string; status: string; remarks?: string[] }[] };
      const pkg = out.packages?.[0];
      if (!res.ok || !pkg?.waybill || pkg.status === "Fail") throw new ProviderError(pkg?.remarks?.join("; ") || out.rmk || "Delhivery did not create the shipment");
      return { shipmentId: pkg.waybill, awb: pkg.waybill, carrier: "Delhivery", labelUrl: await this.label({ shipmentId: pkg.waybill, awb: pkg.waybill }), trackingUrl: delhiveryTrackingUrl(pkg.waybill) };
    },
    async label({ awb }) {
      const body = await get<{ packages?: { pdf_download_link?: string }[] }>(`/api/p/packing_slip?wbns=${encodeURIComponent(awb)}&pdf=true`);
      return body.packages?.[0]?.pdf_download_link ?? null;
    },
    async track(awb) {
      const body = await get<{ ShipmentData?: { Shipment: { Status: { Status: string; StatusDateTime: string }; Scans?: DlvScan[] } }[] }>(`/api/v1/packages/json/?waybill=${encodeURIComponent(awb)}`);
      const s = body.ShipmentData?.[0]?.Shipment;
      if (!s) throw new ProviderError(`Delhivery has no shipment ${awb}`);
      return {
        state: stateFromText(s.Status.Status),
        description: s.Status.Status,
        events: (s.Scans ?? []).map((x) => ({ at: x.ScanDetail.ScanDateTime, description: x.ScanDetail.Instructions || x.ScanDetail.Scan, location: x.ScanDetail.ScannedLocation ?? null })),
      };
    },
    parseWebhook(raw, hdrs) {
      try {
        requireToken(hdrs, "x-delhivery-token", ctx.secrets.webhookToken);
      } catch (err) {
        return Promise.reject(err instanceof Error ? err : new Error(String(err)));
      }
      const body = JSON.parse(raw.toString()) as { Shipment?: { AWB: string; Status: { Status: string; StatusDateTime: string; StatusType?: string; Instructions?: string } } };
      const s = body.Shipment;
      if (!s?.AWB) return Promise.resolve([]);
      const event: TrackingWebhookEvent = {
        id: `${s.AWB}:${s.Status.Status}:${s.Status.StatusDateTime}`,
        awb: s.AWB,
        state: s.Status.StatusType === "DL" ? "delivered" : s.Status.StatusType === "RT" ? "returned" : stateFromText(s.Status.Status),
        description: s.Status.Instructions || s.Status.Status,
        at: s.Status.StatusDateTime,
      };
      return Promise.resolve([event]);
    },
    trackingUrl: delhiveryTrackingUrl,
  };
}

export const delhivery: ProviderDefinition<"shipping", z.infer<typeof configSchema>, z.infer<typeof secretsSchema>> = {
  id: "delhivery",
  kind: "shipping",
  displayName: "Delhivery",
  description: "Delhivery B2C: rates, waybills, packing-slip labels and tracking pushes.",
  docsUrl: "https://one.delhivery.com/developer-portal",
  modes: ["test", "live"],
  configSchema,
  secretsSchema,
  last4Field: "apiToken",
  webhookEvents: ["Shipment status push"],
  create,
};
