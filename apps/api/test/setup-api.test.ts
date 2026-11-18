import { issueSetupToken } from "@shopkit/core";
import { sql } from "@shopkit/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Jar, makeHarness, multipart, PNG, STRONG, type Harness } from "./harness.js";

let h: Harness;
beforeAll(async () => {
  h = await makeHarness();
});
afterAll(() => h.close());
beforeEach(() => h.reset());

const storeBody = {
  name: "Pretty Little Store", email: "hello@pls.test", country: "IN", currency: "INR", timezone: "Asia/Kolkata",
  locale: "en-IN", weightUnit: "kg", publicUrl: "https://shop.test", address: { city: "Bengaluru" },
};

async function start(jar = new Jar()) {
  const token = await issueSetupToken(h.deps.redis);
  const res = jar.absorb(await h.app.inject({ method: "POST", url: "/api/setup/token", payload: { token } }));
  expect(res.statusCode).toBe(200);
  const csrf = res.json<{ csrf: string }>().csrf;
  const call = (method: "GET" | "PUT" | "POST", url: string, payload?: unknown, extra: Record<string, string> = {}) =>
    h.app.inject({ method, url, payload: payload as never, headers: { cookie: jar.header, "x-csrf-token": csrf, ...extra } }).then((r) => jar.absorb(r));
  return { token, csrf, jar, call };
}

describe("setup API", () => {
  it("reports status and rejects every guarded endpoint without a token", async () => {
    expect((await h.app.inject("/api/setup/status")).json()).toEqual({ required: true, step: "token" });
    for (const [method, url] of [["GET", "/api/setup/state"], ["PUT", "/api/setup/owner"], ["PUT", "/api/setup/storage"], ["POST", "/api/setup/launch"]] as const) {
      const res = await h.app.inject({ method, url, payload: {} });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
    }
    const bad = await h.app.inject({ method: "POST", url: "/api/setup/token", payload: { token: "nope" } });
    expect(bad.statusCode).toBe(401);
  });

  it("requires a CSRF header for cookie-authenticated writes; header tokens work for API clients", async () => {
    const { token, jar } = await start();
    const noCsrf = await h.app.inject({ method: "PUT", url: "/api/setup/owner", headers: { cookie: jar.header }, payload: { name: "A", email: "a@b.co", password: STRONG } });
    expect(noCsrf.statusCode).toBe(403);
    const viaHeader = await h.app.inject({ method: "PUT", url: "/api/setup/owner", headers: { "x-setup-token": token }, payload: { name: "Asha", email: "asha@pls.test", password: STRONG } });
    expect(viaHeader.statusCode).toBe(200);
  });

  it("runs the whole wizard over HTTP, never returns secrets, then locks setup", async () => {
    const { call, jar, csrf } = await start();
    expect((await call("PUT", "/api/setup/owner", { name: "Asha", email: "asha@pls.test", password: "password1" })).statusCode).toBe(422);
    expect((await call("PUT", "/api/setup/owner", { name: "Asha", email: "asha@pls.test", password: STRONG })).statusCode).toBe(200);

    const failed = await call("POST", "/api/setup/credentials/storage/test", {
      provider: "s3-compatible", mode: "live", config: { endpoint: "http://127.0.0.1:1", bucket: "shop" }, secrets: { accessKeyId: "key", secretAccessKey: "secret-value" },
    });
    expect(failed.json()).toMatchObject({ ok: false });
    const ok = await call("POST", "/api/setup/credentials/storage/test", { provider: "local", mode: "live" });
    expect(ok.json()).toEqual({ ok: true });
    expect((await call("PUT", "/api/setup/storage", { provider: "local", mode: "live" })).statusCode).toBe(200);

    expect((await call("PUT", "/api/setup/store", storeBody)).statusCode).toBe(200);
    const upload = multipart("file", "logo.png", PNG);
    const logo = jar.absorb(await h.app.inject({ method: "POST", url: "/api/setup/store/logo", payload: upload.payload,
      headers: { ...upload.headers, cookie: jar.header, "x-csrf-token": csrf } }));
    expect(logo.statusCode).toBe(200);
    const logoUrl = logo.json<{ url: string }>().url;

    const rzp = await call("PUT", "/api/setup/credentials/payment", {
      provider: "razorpay", mode: "test", config: { keyId: "rzp_test_abc123" }, secrets: { keySecret: "rzp_SUPERSECRET_4321", webhookSecret: "whsec_HIDDEN_99" },
    });
    expect(rzp.statusCode).toBe(200);
    expect(rzp.json()).toMatchObject({ configured: true, last4: "4321", secretFields: ["keySecret", "webhookSecret"] });
    expect(rzp.body).not.toContain("SUPERSECRET");
    expect((await call("PUT", "/api/setup/credentials/payment", { provider: "cod", mode: "live" })).statusCode).toBe(200);
    expect((await call("POST", "/api/setup/steps/payments", { payments: { mode: "test" } })).statusCode).toBe(200);
    expect((await call("POST", "/api/setup/steps/email", { skip: true })).statusCode).toBe(200);
    expect((await call("PUT", "/api/setup/credentials/analytics", { provider: "plausible", mode: "live", config: { domain: "shop.test.com" } })).statusCode).toBe(200);
    expect((await call("POST", "/api/setup/steps/analytics", { analytics: { consentBanner: true } })).statusCode).toBe(200);
    expect((await call("PUT", "/api/setup/shipping-tax", { skip: true })).statusCode).toBe(200);

    const state = await call("GET", "/api/setup/state");
    expect(state.statusCode).toBe(200);
    expect(state.json()).toMatchObject({ currentStep: "review", owner: { email: "asha@pls.test" }, store: { name: "Pretty Little Store", logoUrl } });
    expect(state.body).not.toContain("SUPERSECRET");
    expect(state.body).not.toContain("whsec_HIDDEN");

    const { rows } = await h.deps.db.execute<{ c: string }>(sql`select encode(ciphertext, 'escape') || encode(wrapped_dek, 'escape') || config::text as c from provider_credentials`);
    expect(rows.map((r) => r.c).join()).not.toMatch(/SUPERSECRET|HIDDEN/);

    const launch = await call("POST", "/api/setup/launch");
    expect(launch.statusCode).toBe(200);
    expect(jar.cookies.get("sk_session")).toBeTruthy();
    expect(jar.cookies.has("sk_setup")).toBe(false);

    // After launch: setup endpoints are closed, the owner is signed in, storefront is live.
    expect((await call("GET", "/api/setup/state")).statusCode).toBe(410);
    expect((await call("PUT", "/api/setup/store", storeBody)).statusCode).toBe(410);
    expect((await h.app.inject({ method: "POST", url: "/api/setup/token", payload: { token: "anything" } })).statusCode).toBe(410);
    expect((await h.app.inject("/api/setup/status")).json()).toEqual({ required: false, step: "review" });
    const me = await h.app.inject({ url: "/api/admin/auth/me", headers: { cookie: jar.header } });
    expect(me.json()).toMatchObject({ staff: { role: "owner" }, store: { status: "active" } });
    const sf = await h.app.inject("/api/storefront/store");
    expect(sf.json()).toEqual({ setupRequired: false, store: expect.objectContaining({ name: "Pretty Little Store", logoUrl }) });

    const media = await h.app.inject(new URL(logoUrl).pathname);
    expect(media.statusCode).toBe(200);
    expect(media.headers["content-type"]).toBe("image/png");
    expect(media.headers["x-content-type-options"]).toBe("nosniff");
    expect(media.rawPayload.equals(PNG)).toBe(true);
    expect((await h.app.inject("/media/not-a-uuid/x.png")).statusCode).toBe(404);
  });

  it("storefront shows coming soon before launch", async () => {
    expect((await h.app.inject("/api/storefront/store")).json()).toEqual({ setupRequired: true, store: null });
  });
});
