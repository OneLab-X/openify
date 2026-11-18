import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { GA4_MP, ga4 } from "../src/analytics/ga4.js";
import { plausible } from "../src/analytics/plausible.js";
import { RESEND_API, resend } from "../src/email/resend.js";
import { ProviderError } from "../src/types.js";
import { ctx } from "./helpers.js";

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledFrame: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe("resend", () => {
  const p = resend.create(ctx({ fromEmail: "shop@example.com", fromName: "Shop" }, { apiKey: "re_abc_123" }, "live"));

  it("accepts full and sending-only keys, rejects bad ones", async () => {
    server.use(http.get(`${RESEND_API}/domains`, () => HttpResponse.json({ data: [] })));
    expect(await p.testCredentials()).toEqual({ ok: true });
    server.use(http.get(`${RESEND_API}/domains`, () =>
      HttpResponse.json({ name: "restricted_api_key", message: "restricted" }, { status: 401 })));
    expect(await p.testCredentials()).toMatchObject({ ok: true });
    server.use(http.get(`${RESEND_API}/domains`, () =>
      HttpResponse.json({ name: "validation_error", message: "API key is invalid" }, { status: 400 })));
    expect(await p.testCredentials()).toEqual({ ok: false, error: "API key is invalid" });
    server.use(http.get(`${RESEND_API}/domains`, () => HttpResponse.error()));
    expect(await p.testCredentials()).toMatchObject({ ok: false, error: expect.stringMatching(/could not be reached/) });
  });

  it("sends with an idempotency key", async () => {
    let key = "";
    let body: Record<string, unknown> = {};
    server.use(http.post(`${RESEND_API}/emails`, async ({ request }) => {
      key = request.headers.get("idempotency-key") ?? "";
      body = (await request.json()) as Record<string, unknown>;
      return HttpResponse.json({ id: "em_1" });
    }));
    expect(await p.send({ to: "a@b.co", subject: "S", html: "<p/>", text: "t", replyTo: "r@b.co", idempotencyKey: "order-1:confirm" }))
      .toEqual({ id: "em_1" });
    expect(key).toBe("order-1:confirm");
    expect(body).toMatchObject({ from: '"Shop" <shop@example.com>', to: ["a@b.co"], reply_to: "r@b.co" });
    server.use(http.post(`${RESEND_API}/emails`, () => HttpResponse.json({ message: "bad from" }, { status: 422 })));
    await expect(p.send({ to: "a@b.co", subject: "S", html: "", text: "", idempotencyKey: "x" })).rejects.toThrow("bad from");
  });

  it("validates key format", () => {
    expect(resend.secretsSchema.safeParse({ apiKey: "sk_live" }).success).toBe(false);
  });
});

describe("ga4", () => {
  const withSecret = ga4.create(ctx({ measurementId: "G-ABC1234" }, { apiSecret: "secret-123" }, "live"));
  const withoutSecret = ga4.create(ctx({ measurementId: "G-ABC1234" }, {}, "live"));

  it("snippet requires consent and embeds the id safely", () => {
    const s = withoutSecret.clientSnippet();
    expect(s.requiresConsent).toBe(true);
    expect(s.head).toContain("gtag('config',\"G-ABC1234\")");
  });

  it("tests via the debug endpoint when an API secret is set", async () => {
    expect(await withoutSecret.testCredentials()).toMatchObject({ ok: true });
    server.use(http.post(`${GA4_MP}/debug/mp/collect`, () => HttpResponse.json({ validationMessages: [] })));
    expect(await withSecret.testCredentials()).toEqual({ ok: true });
    server.use(http.post(`${GA4_MP}/debug/mp/collect`, () =>
      HttpResponse.json({ validationMessages: [{ description: "Invalid api_secret" }] })));
    expect(await withSecret.testCredentials()).toEqual({ ok: false, error: "Invalid api_secret" });
    server.use(http.post(`${GA4_MP}/debug/mp/collect`, () => new HttpResponse(null, { status: 500 })));
    expect(await withSecret.testCredentials()).toMatchObject({ ok: false });
    server.use(http.post(`${GA4_MP}/debug/mp/collect`, () => HttpResponse.error()));
    expect(await withSecret.testCredentials()).toMatchObject({ ok: false });
  });

  it("sends server purchase events only with an API secret", async () => {
    let body: { events: { name: string; params: Record<string, unknown> }[] } | undefined;
    server.use(http.post(`${GA4_MP}/mp/collect`, async ({ request }) => {
      body = (await request.json()) as typeof body;
      return new HttpResponse(null, { status: 204 });
    }));
    await withoutSecret.serverEvent!("purchase", { orderId: "o1", value: 499, currency: "INR" });
    expect(body).toBeUndefined();
    await withSecret.serverEvent!("purchase", { orderId: "o1", value: 499, currency: "INR" });
    expect(body!.events[0]).toEqual({ name: "purchase", params: { transaction_id: "o1", value: 499, currency: "INR" } });
    await withSecret.serverEvent!("signup", {});
    expect(body!.events[0]!.name).toBe("sign_up");
    server.use(http.post(`${GA4_MP}/mp/collect`, () => new HttpResponse(null, { status: 400 })));
    await expect(withSecret.serverEvent!("refund", {})).rejects.toThrow(ProviderError);
  });
});

describe("plausible", () => {
  const p = plausible.create(ctx({ domain: "shop.example.com", apiHost: "https://stats.example.com/" }, {}, "live"));

  it("snippet is cookieless and escaped", () => {
    expect(p.clientSnippet()).toEqual({
      head: '<script defer data-domain="shop.example.com" src="https://stats.example.com/js/script.js"></script>',
      requiresConsent: false,
    });
  });

  it("tests by fetching the script", async () => {
    server.use(http.get("https://stats.example.com/js/script.js", () => HttpResponse.text("//")));
    expect(await p.testCredentials()).toEqual({ ok: true });
    server.use(http.get("https://stats.example.com/js/script.js", () => new HttpResponse(null, { status: 404 })));
    expect(await p.testCredentials()).toMatchObject({ ok: false, error: expect.stringMatching(/404/) });
    server.use(http.get("https://stats.example.com/js/script.js", () => HttpResponse.error()));
    expect(await p.testCredentials()).toMatchObject({ ok: false });
  });

  it("sends revenue events", async () => {
    let body: Record<string, unknown> = {};
    let xff = "";
    server.use(http.post("https://stats.example.com/api/event", async ({ request }) => {
      body = (await request.json()) as Record<string, unknown>;
      xff = request.headers.get("x-forwarded-for") ?? "";
      return new HttpResponse(null, { status: 202 });
    }));
    await p.serverEvent!("purchase", { orderId: "o1", value: 4.99, currency: "INR", ip: "1.2.3.4" });
    expect(body).toMatchObject({ name: "Purchase", domain: "shop.example.com", url: "https://shop.test/",
      props: { orderId: "o1" }, revenue: { amount: 4.99, currency: "INR" } });
    expect(xff).toBe("1.2.3.4");
    await p.serverEvent!("refund", {});
    expect(body.name).toBe("Refund");
    await p.serverEvent!("signup", { url: "https://shop.test/x" });
    expect(body).toMatchObject({ name: "Signup", url: "https://shop.test/x" });
    server.use(http.post("https://stats.example.com/api/event", () => new HttpResponse(null, { status: 400 })));
    await expect(p.serverEvent!("purchase", {})).rejects.toThrow(ProviderError);
  });
});
