import { createHash } from "node:crypto";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { matomo } from "../src/analytics/matomo.js";
import { META_GRAPH, metaPixel } from "../src/analytics/meta-pixel.js";
import { posthog } from "../src/analytics/posthog.js";
import { umami } from "../src/analytics/umami.js";
import { ctx } from "./helpers.js";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const PURCHASE = { orderId: "#1001", value: 799, currency: "INR", clientId: "0190a1b2-0000-7000-8000-00000000abcd", email: " Buyer@Example.com " };

describe("umami", () => {
  const p = umami.create(ctx({ websiteId: "9b1f4c1e-8a6d-4f0e-9a2b-1c3d4e5f6a7b", host: "https://stats.example.com/" }, {}, "live"));
  it("cookieless snippet and server events", async () => {
    const s = p.clientSnippet();
    expect(s).toEqual({ head: '<script defer src="https://stats.example.com/script.js" data-website-id="9b1f4c1e-8a6d-4f0e-9a2b-1c3d4e5f6a7b"></script>', requiresConsent: false });
    let body: Record<string, unknown> = {};
    server.use(http.post("https://stats.example.com/api/send", async ({ request }) => ((body = (await request.json()) as Record<string, unknown>), HttpResponse.json({}))));
    await p.serverEvent!("purchase", PURCHASE);
    expect(body).toMatchObject({ type: "event", payload: { website: "9b1f4c1e-8a6d-4f0e-9a2b-1c3d4e5f6a7b", hostname: "shop.test", name: "purchase", data: { orderId: "#1001", revenue: 799, currency: "INR" } } });
    server.use(http.post("https://stats.example.com/api/send", () => new HttpResponse(null, { status: 400 })));
    await expect(p.serverEvent!("refund", PURCHASE)).rejects.toThrow(/Umami event failed/);
  });
});

describe("matomo", () => {
  it("requires consent unless cookieless; server orders go to the tracking API", async () => {
    const withCookies = matomo.create(ctx({ url: "https://m.example.com", siteId: 3, cookieless: false }, {}, "live"));
    expect(withCookies.clientSnippet()).toMatchObject({ requiresConsent: true });
    const p = matomo.create(ctx({ url: "https://m.example.com/", siteId: 3, cookieless: true }, { tokenAuth: "0123456789abcdef0123" }, "live"));
    const s = p.clientSnippet();
    expect(s.requiresConsent).toBe(false);
    expect(s.head).toContain("_paq.push(['disableCookies'])");
    expect(s.head).toContain('_paq.push([\'setSiteId\',"3"])');
    let form = new URLSearchParams();
    server.use(http.post("https://m.example.com/matomo.php", async ({ request }) => ((form = new URLSearchParams(await request.text())), new HttpResponse(null, { status: 204 }))));
    await p.serverEvent!("purchase", PURCHASE);
    expect(Object.fromEntries(form)).toMatchObject({ idsite: "3", idgoal: "0", ec_id: "#1001", revenue: "799", token_auth: "0123456789abcdef0123" });
    expect(form.get("_id")).toMatch(/^[0-9a-f]{16}$/);
    await p.serverEvent!("refund", PURCHASE); // no refund API: no request
  });
});

describe("posthog", () => {
  const p = posthog.create(ctx({ apiKey: "phc_abcdefghijklmnopqrstuvwx", host: "https://eu.i.posthog.com" }, {}, "live"));
  it("consent-gated snippet and capture endpoint", async () => {
    const s = p.clientSnippet();
    expect(s.requiresConsent).toBe(true);
    expect(s.head).toContain('posthog.init("phc_abcdefghijklmnopqrstuvwx",{api_host:"https://eu.i.posthog.com"');
    let body: Record<string, unknown> = {};
    server.use(http.post("https://eu.i.posthog.com/capture/", async ({ request }) => ((body = (await request.json()) as Record<string, unknown>), HttpResponse.json({ status: 1 }))));
    await p.serverEvent!("refund", PURCHASE);
    expect(body).toMatchObject({ api_key: "phc_abcdefghijklmnopqrstuvwx", event: "refund", distinct_id: PURCHASE.clientId, properties: { order_id: "#1001", revenue: 799, currency: "INR" } });
  });
});

describe("meta pixel", () => {
  it("consent-gated pixel; Conversions API purchase with a hashed email only", async () => {
    const p = metaPixel.create(ctx({ pixelId: "123456789012" }, { accessToken: "EAAB-test-access-token-1234" }, "live"));
    expect(p.clientSnippet()).toMatchObject({ requiresConsent: true });
    expect(p.clientSnippet().head).toContain("fbq('init',\"123456789012\")");
    let body: { data: Record<string, unknown>[] } = { data: [] };
    server.use(http.post(`${META_GRAPH}/123456789012/events`, async ({ request }) => ((body = (await request.json()) as typeof body), HttpResponse.json({ events_received: 1 }))));
    await p.serverEvent!("purchase", PURCHASE);
    expect(body.data[0]).toMatchObject({ event_name: "Purchase", event_id: "#1001", user_data: { em: [createHash("sha256").update("buyer@example.com").digest("hex")] }, custom_data: { value: 799, currency: "INR" } });
    expect(JSON.stringify(body)).not.toContain("Buyer@Example.com");
    await p.serverEvent!("refund", PURCHASE); // ignored
    const noToken = metaPixel.create(ctx({ pixelId: "123456789012" }, {}, "live"));
    await noToken.serverEvent!("purchase", PURCHASE); // no request without a token
  });
});
