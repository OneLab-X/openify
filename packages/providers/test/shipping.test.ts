import { createHmac } from "node:crypto";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { courierTrackingUrl, KNOWN_COURIERS } from "../src/shipping/couriers.js";
import { DELHIVERY_API, delhivery } from "../src/shipping/delhivery.js";
import { EASYPOST_API, easypost } from "../src/shipping/easypost.js";
import { stateFromText } from "../src/shipping/shared.js";
import { SHIPROCKET_API, shiprocket } from "../src/shipping/shiprocket.js";
import { WebhookSignatureError, type CreateShipmentInput } from "../src/types.js";
import { ctx } from "./helpers.js";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const FROM = { name: "PLS", line1: "1 Shop St", city: "Bengaluru", province: "Karnataka", postalCode: "560001", country: "IN", phone: "9000000000" };
const TO = { name: "Asha Kumar", line1: "12 MG Road", city: "Mumbai", province: "Maharashtra", postalCode: "400001", country: "IN", phone: "9876543210", email: "asha@example.com" };
const SHIPMENT: CreateShipmentInput = {
  from: FROM,
  to: TO,
  parcel: { weightGrams: 750 },
  declaredValue: 199_800,
  currency: "INR",
  reference: "0190a1b2-0000-7000-8000-00000000f001",
  orderName: "#1001",
  orderDate: "2026-11-19T10:00:00.000Z",
  items: [{ name: "Tee", sku: "TEE-S", quantity: 2, unitPrice: 99_900, hsnCode: "6109" }],
};

describe("shiprocket", () => {
  const p = shiprocket.create(ctx({ email: "api@pls.test", pickupLocation: "Primary" }, { password: "secret-pass", webhookToken: "sr-webhook-token" }, "live"));
  const login = http.post(`${SHIPROCKET_API}/auth/login`, () => HttpResponse.json({ token: "jwt-1" }));

  it("logs in once and quotes courier rates", async () => {
    let logins = 0;
    let query = "";
    server.use(
      http.post(`${SHIPROCKET_API}/auth/login`, () => (logins++, HttpResponse.json({ token: "jwt-1" }))),
      http.get(`${SHIPROCKET_API}/courier/serviceability/`, ({ request }) => {
        query = new URL(request.url).search;
        expect(request.headers.get("authorization")).toBe("Bearer jwt-1");
        return HttpResponse.json({ data: { available_courier_companies: [{ courier_company_id: 10, courier_name: "Delhivery Surface", rate: 72.5, estimated_delivery_days: "4" }, { courier_company_id: 11, courier_name: "Xpressbees", rate: 65 }] } });
      }),
    );
    const rates = await p.rates(SHIPMENT);
    await p.rates(SHIPMENT);
    expect(logins).toBe(1);
    expect(query).toContain("weight=0.75");
    expect(rates).toEqual([
      { id: "10", name: "Delhivery Surface", carrier: "Delhivery Surface", amount: 7250, currency: "INR", etaDays: 4 },
      { id: "11", name: "Xpressbees", carrier: "Xpressbees", amount: 6500, currency: "INR" },
    ]);
  });

  it("creates an order, assigns the cheapest courier's AWB and fetches the label", async () => {
    let order: Record<string, unknown> = {};
    let assigned: Record<string, unknown> = {};
    server.use(
      login,
      http.post(`${SHIPROCKET_API}/orders/create/adhoc`, async ({ request }) => ((order = (await request.json()) as Record<string, unknown>), HttpResponse.json({ order_id: 5, shipment_id: 77 }))),
      http.get(`${SHIPROCKET_API}/courier/serviceability/`, () => HttpResponse.json({ data: { available_courier_companies: [{ courier_company_id: 10, courier_name: "A", rate: 90 }, { courier_company_id: 11, courier_name: "B", rate: 65 }] } })),
      http.post(`${SHIPROCKET_API}/courier/assign/awb`, async ({ request }) => ((assigned = (await request.json()) as Record<string, unknown>), HttpResponse.json({ awb_assign_status: 1, response: { data: { awb_code: "SR123", courier_name: "B" } } }))),
      http.post(`${SHIPROCKET_API}/courier/generate/label`, () => HttpResponse.json({ label_created: 1, label_url: "https://sr.example/label.pdf" })),
    );
    const s = await p.createShipment(SHIPMENT);
    expect(order).toMatchObject({ order_id: SHIPMENT.reference, pickup_location: "Primary", billing_pincode: "400001", payment_method: "Prepaid", sub_total: "1998.00", weight: 0.75 });
    expect(assigned).toEqual({ shipment_id: 77, courier_id: 11 });
    expect(s).toEqual({ shipmentId: "77", awb: "SR123", carrier: "B", labelUrl: "https://sr.example/label.pdf", trackingUrl: "https://shiprocket.co/tracking/SR123" });
  });

  it("tracks and verifies webhooks by token", async () => {
    server.use(
      login,
      http.get(`${SHIPROCKET_API}/courier/track/awb/SR123`, () =>
        HttpResponse.json({ tracking_data: { shipment_track: [{ current_status: "Out For Delivery" }], shipment_track_activities: [{ date: "2026-11-20 09:00", activity: "Out for delivery", location: "Mumbai" }] } }),
      ),
    );
    expect(await p.track("SR123")).toEqual({ state: "out_for_delivery", description: "Out For Delivery", events: [{ at: "2026-11-20 09:00", description: "Out for delivery", location: "Mumbai" }] });
    const body = Buffer.from(JSON.stringify({ awb: "SR123", current_status: "DELIVERED", current_status_id: 7, current_timestamp: "2026-11-20 18:00" }));
    expect(await p.parseWebhook(body, { "x-api-key": "sr-webhook-token" })).toEqual([{ id: "SR123:7:2026-11-20 18:00", awb: "SR123", state: "delivered", description: "DELIVERED", at: "2026-11-20 18:00" }]);
    await expect(p.parseWebhook(body, { "x-api-key": "wrong-token-0" })).rejects.toBeInstanceOf(WebhookSignatureError);
  });

  it("reports bad credentials", async () => {
    server.use(http.post(`${SHIPROCKET_API}/auth/login`, () => HttpResponse.json({ message: "Invalid email and password combination" }, { status: 400 })));
    expect(await p.testCredentials()).toEqual({ ok: false, error: "Invalid email and password combination" });
  });
});

describe("delhivery", () => {
  const p = delhivery.create(ctx({ pickupLocation: "PLS WH", serviceMode: "S" as const }, { apiToken: "dlv-token-123", webhookToken: "dlv-hook-token" }, "test"));
  const base = DELHIVERY_API.test;

  it("quotes, creates with a waybill and fetches the packing slip", async () => {
    let created = "";
    server.use(
      http.get(`${base}/api/kinko/v1/invoice/charges/.json`, ({ request }) => {
        expect(request.headers.get("authorization")).toBe("Token dlv-token-123");
        expect(new URL(request.url).searchParams.get("cgm")).toBe("750");
        return HttpResponse.json([{ total_amount: 84.96 }]);
      }),
      http.post(`${base}/api/cmu/create.json`, async ({ request }) => ((created = await request.text()), HttpResponse.json({ success: true, packages: [{ waybill: "DLV999", status: "Success" }] }))),
      http.get(`${base}/api/p/packing_slip`, () => HttpResponse.json({ packages: [{ pdf_download_link: "https://dlv.example/slip.pdf" }] })),
    );
    expect(await p.rates(SHIPMENT)).toEqual([{ id: "S0", name: "Delhivery Surface", carrier: "Delhivery", amount: 8496, currency: "INR" }]);
    const s = await p.createShipment(SHIPMENT);
    const data = JSON.parse(decodeURIComponent(created.replace(/^format=json&data=/, ""))) as { shipments: Record<string, string>[]; pickup_location: { name: string } };
    expect(data.pickup_location.name).toBe("PLS WH");
    expect(data.shipments[0]).toMatchObject({ pin: "400001", order: SHIPMENT.reference, payment_mode: "Prepaid", total_amount: "1998.00", weight: "750", hsn_code: "6109" });
    expect(s).toEqual({ shipmentId: "DLV999", awb: "DLV999", carrier: "Delhivery", labelUrl: "https://dlv.example/slip.pdf", trackingUrl: "https://www.delhivery.com/track/package/DLV999" });
  });

  it("surfaces creation failures", async () => {
    server.use(http.post(`${base}/api/cmu/create.json`, () => HttpResponse.json({ success: false, packages: [{ waybill: "", status: "Fail", remarks: ["Pincode not serviceable"] }] })));
    await expect(p.createShipment(SHIPMENT)).rejects.toThrow("Pincode not serviceable");
  });

  it("tracks and parses pushes", async () => {
    server.use(
      http.get(`${base}/api/v1/packages/json/`, () =>
        HttpResponse.json({ ShipmentData: [{ Shipment: { Status: { Status: "In Transit", StatusDateTime: "2026-11-20T10:00" }, Scans: [{ ScanDetail: { Scan: "Manifested", ScanDateTime: "2026-11-19T18:00", ScannedLocation: "Bengaluru" } }] } }] }),
      ),
    );
    expect((await p.track("DLV999")).state).toBe("in_transit");
    const push = Buffer.from(JSON.stringify({ Shipment: { AWB: "DLV999", Status: { Status: "Delivered", StatusType: "DL", StatusDateTime: "2026-11-21T12:00", Instructions: "Delivered to consignee" } } }));
    expect(await p.parseWebhook(push, { "x-delhivery-token": "dlv-hook-token" })).toEqual([
      { id: "DLV999:Delivered:2026-11-21T12:00", awb: "DLV999", state: "delivered", description: "Delivered to consignee", at: "2026-11-21T12:00" },
    ]);
    await expect(p.parseWebhook(push, {})).rejects.toBeInstanceOf(WebhookSignatureError);
  });
});

describe("easypost", () => {
  const p = easypost.create(ctx({ carriers: [] as string[] }, { apiKey: "EZTK_test_key", webhookSecret: "ep-webhook-secret" }, "test"));
  const shipmentBody = { id: "shp_1", rates: [{ id: "rate_a", carrier: "USPS", service: "Priority", rate: "9.40", currency: "USD", delivery_days: 2 }, { id: "rate_b", carrier: "UPS", service: "Ground", rate: "12.10", currency: "USD" }] };

  it("quotes rates in minor units and buys the cheapest", async () => {
    let bought = "";
    let weight = 0;
    server.use(
      http.post(`${EASYPOST_API}/shipments`, async ({ request }) => {
        expect(request.headers.get("authorization")).toBe(`Basic ${Buffer.from("EZTK_test_key:").toString("base64")}`);
        weight = ((await request.json()) as { shipment: { parcel: { weight: number } } }).shipment.parcel.weight;
        return HttpResponse.json(shipmentBody);
      }),
      http.post(`${EASYPOST_API}/shipments/shp_1/buy`, async ({ request }) => {
        bought = ((await request.json()) as { rate: { id: string } }).rate.id;
        return HttpResponse.json({ id: "shp_1", rates: [], tracking_code: "9400111", selected_rate: shipmentBody.rates[0], postage_label: { label_url: "https://ep.example/l.png", label_pdf_url: "https://ep.example/l.pdf" }, tracker: { public_url: "https://track.easypost.com/x" } });
      }),
    );
    expect(await p.rates(SHIPMENT)).toEqual([
      { id: "rate_a", name: "USPS Priority", carrier: "USPS", amount: 940, currency: "USD", etaDays: 2 },
      { id: "rate_b", name: "UPS Ground", carrier: "UPS", amount: 1210, currency: "USD" },
    ]);
    expect(weight).toBe(26.5);
    expect(await p.createShipment(SHIPMENT)).toEqual({ shipmentId: "shp_1", awb: "9400111", carrier: "USPS", labelUrl: "https://ep.example/l.pdf", trackingUrl: "https://track.easypost.com/x" });
    expect(bought).toBe("rate_a");
  });

  it("verifies HMAC-signed tracker webhooks", async () => {
    const body = Buffer.from(JSON.stringify({ id: "evt_1", description: "tracker.updated", result: { tracking_code: "9400111", status: "out_for_delivery", status_detail: "Out for delivery", updated_at: "2026-11-20T08:00:00Z" } }));
    const sig = `hmac-sha256-hex=${createHmac("sha256", "ep-webhook-secret").update(body).digest("hex")}`;
    expect(await p.parseWebhook(body, { "x-hmac-signature": sig })).toEqual([{ id: "evt_1", awb: "9400111", state: "out_for_delivery", description: "Out for delivery", at: "2026-11-20T08:00:00Z" }]);
    await expect(p.parseWebhook(body, { "x-hmac-signature": "hmac-sha256-hex=00" })).rejects.toBeInstanceOf(WebhookSignatureError);
  });
});

describe("couriers and status mapping", () => {
  it("builds tracking links for known couriers", () => {
    expect(courierTrackingUrl("delhivery", " 123 ")).toBe("https://www.delhivery.com/track/package/123");
    expect(courierTrackingUrl("unknown", "1")).toBeNull();
    expect(courierTrackingUrl("bluedart", "")).toBeNull();
    expect(new Set(KNOWN_COURIERS.map((c) => c.id)).size).toBe(KNOWN_COURIERS.length);
  });

  it.each([
    ["Delivered", "delivered"],
    ["Out for Delivery", "out_for_delivery"],
    ["In Transit", "in_transit"],
    ["Picked Up", "in_transit"],
    ["RTO Initiated", "returned"],
    ["Undelivered", "failed"],
    ["Manifested", "in_transit"],
    ["Pickup Scheduled", "pending"],
  ])("maps %s → %s", (text, state) => expect(stateFromText(text)).toBe(state));
});
