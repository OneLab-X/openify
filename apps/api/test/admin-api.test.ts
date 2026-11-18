import { beginSetup, ensureSystemRoles, hashPassword, launchStore, saveOwnerStep, saveStorageStep, saveStoreStep } from "@shopkit/core";
import { roles, staffUsers, eq, and } from "@shopkit/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { main as cli } from "../src/cli.js";
import { Jar, makeHarness, STRONG, type Harness } from "./harness.js";

let h: Harness;
let storeId: string;
beforeAll(async () => {
  h = await makeHarness();
});
afterAll(() => h.close());
beforeEach(async () => {
  await h.reset();
  storeId = await beginSetup(h.deps);
  const actor = { type: "setup" as const };
  await saveOwnerStep(h.deps, actor, { name: "Asha", email: "asha@pls.test", password: STRONG });
  await saveStorageStep(h.deps, actor, { provider: "local", mode: "live" });
  await saveStoreStep(h.deps, actor, {
    name: "PLS", email: "hello@pls.test", country: "IN", currency: "INR", timezone: "UTC", locale: "en-IN", weightUnit: "kg", publicUrl: "https://shop.test",
  });
  await launchStore(h.deps, actor);
});

async function signIn(email = "asha@pls.test", password = STRONG) {
  const jar = new Jar();
  const res = jar.absorb(await h.app.inject({ method: "POST", url: "/api/admin/auth/login", payload: { email, password } }));
  const csrf = res.statusCode === 200 ? res.json<{ csrf: string }>().csrf : "";
  const call = (method: "GET" | "PUT" | "POST" | "DELETE", url: string, payload?: unknown, withCsrf = true) =>
    h.app.inject({ method, url, payload: payload as never, headers: { cookie: jar.header, ...(withCsrf ? { "x-csrf-token": csrf } : {}) } });
  return { res, jar, csrf, call };
}

async function addStaff(role: "admin" | "staff", email: string) {
  const ids = await ensureSystemRoles(h.deps.db, storeId);
  await h.deps.db.insert(staffUsers).values({ storeId, roleId: ids[role], name: role, email, passwordHash: await hashPassword(STRONG) });
}

describe("admin auth", () => {
  it("signs in with httpOnly session + readable CSRF cookie", async () => {
    const { res } = await signIn();
    expect(res.statusCode).toBe(200);
    const session = res.cookies.find((c) => c.name === "sk_session")!;
    expect(session).toMatchObject({ httpOnly: true, sameSite: "Lax", secure: true, path: "/" });
    expect(res.cookies.find((c) => c.name === "sk_csrf")!.httpOnly).toBeFalsy();
  });

  it("locks out after 5 failed attempts", async () => {
    for (let i = 0; i < 4; i++) expect((await signIn("asha@pls.test", "wrong")).res.statusCode).toBe(401);
    expect((await signIn("asha@pls.test", "wrong")).res.statusCode).toBe(423);
    expect((await signIn()).res.statusCode).toBe(423);
  });

  it("rate-limits login per IP", async () => {
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) codes.push((await signIn("nobody@pls.test", "x")).res.statusCode);
    expect(codes.slice(-1)[0]).toBe(429);
  });

  it("rejects mutating requests without CSRF and signs out", async () => {
    const { call, jar } = await signIn();
    expect((await call("PUT", "/api/settings/payments.mode", { value: "live" }, false)).statusCode).toBe(404);
    expect((await call("PUT", "/api/admin/settings/payments.mode", { value: "live" }, false)).statusCode).toBe(403);
    expect((await call("PUT", "/api/admin/settings/payments.mode", { value: "live" })).statusCode).toBe(200);
    jar.absorb(await call("POST", "/api/admin/auth/logout"));
    expect((await call("GET", "/api/admin/auth/me")).statusCode).toBe(401);
  });
});

describe("admin settings", () => {
  it("credentials are write-only; RBAC per provider kind", async () => {
    const owner = await signIn();
    const save = await owner.call("PUT", "/api/admin/credentials/email/resend/live", {
      config: { fromEmail: "shop@pls.test" }, secrets: { apiKey: "re_TOPSECRET_abcd" },
    });
    expect(save.statusCode).toBe(200);
    expect(save.body).not.toContain("TOPSECRET");
    const list = await owner.call("GET", "/api/admin/credentials?kind=email");
    expect(list.json()).toEqual([expect.objectContaining({ provider: "resend", last4: "abcd", secretFields: ["apiKey"] })]);
    expect(list.body).not.toContain("TOPSECRET");

    const providers = await owner.call("GET", "/api/admin/providers?kind=payment");
    expect(providers.json<{ id: string }[]>().map((p) => p.id)).toEqual(expect.arrayContaining(["razorpay", "cod", "stripe"]));

    await addStaff("admin", "admin@pls.test");
    const admin = await signIn("admin@pls.test");
    expect((await admin.call("PUT", "/api/admin/credentials/payment/cod/live", {})).statusCode).toBe(403);
    expect((await admin.call("PUT", "/api/admin/credentials/email/smtp/live", { config: { host: "smtp.test", fromEmail: "a@b.co" } })).statusCode).toBe(200);

    await addStaff("staff", "staff@pls.test");
    const staff = await signIn("staff@pls.test");
    expect((await staff.call("GET", "/api/admin/credentials")).statusCode).toBe(403);
    expect((await staff.call("GET", "/api/admin/audit-logs")).statusCode).toBe(403);
  });

  it("cannot delete the active storage provider; validates setting targets", async () => {
    const { call } = await signIn();
    expect((await call("DELETE", "/api/admin/credentials/storage/local/live")).statusCode).toBe(409);
    expect((await call("PUT", "/api/admin/settings/email.active", { value: { provider: "smtp", mode: "live" } })).statusCode).toBe(422);
    expect((await call("PUT", "/api/admin/settings/tax.config", { value: { mode: "generic" } })).statusCode).toBe(422);
    const settings = await call("GET", "/api/admin/settings");
    expect(settings.json()).toMatchObject({ storage: { provider: "local" }, paymentsMode: "test" });
  });

  it("audit log paginates and contains no secrets", async () => {
    const { call } = await signIn();
    await call("PUT", "/api/admin/credentials/payment/razorpay/test", { config: { keyId: "rzp_test_x1" }, secrets: { keySecret: "SECRETVALUE_1234" } });
    const first = await call("GET", "/api/admin/audit-logs?limit=3");
    const page = first.json<{ items: { action: string }[]; nextCursor: string }>();
    expect(page.items).toHaveLength(3);
    expect(page.items[0]!.action).toBe("credential.created");
    const second = await call("GET", `/api/admin/audit-logs?limit=50&cursor=${page.nextCursor}`);
    const all = [...page.items, ...second.json<{ items: unknown[] }>().items];
    expect(all.length).toBeGreaterThan(5);
    expect(JSON.stringify(all)).not.toContain("SECRETVALUE");
  });

  it("updates store details", async () => {
    const { call } = await signIn();
    const res = await call("PUT", "/api/admin/store", {
      name: "PLS 2", email: "hello@pls.test", country: "IN", currency: "INR", timezone: "UTC", locale: "en-IN", weightUnit: "g",
      publicUrl: "https://shop.test", brand: { primaryColor: "#ff0000" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ name: "PLS 2", weightUnit: "g", brand: { primaryColor: "#ff0000" } });
  });
});

describe("cli", () => {
  it("keys:verify and keys:rotate", async () => {
    const { call } = await signIn();
    await call("PUT", "/api/admin/credentials/payment/razorpay/test", { config: { keyId: "rzp_test_x1" }, secrets: { keySecret: "SECRETVALUE_1234" } });
    const lines: string[] = [];
    const saved = { ...process.env };
    Object.assign(process.env, h.env);
    try {
      expect(await cli(["keys:verify"], (l) => lines.push(l))).toBe(0);
      expect(lines.at(-1)).toMatch(/checked 2 secret\(s\), 0 failed/);
      process.env.SHOPKIT_MASTER_KEY_2 = Buffer.alloc(32, 7).toString("base64");
      expect(await cli(["keys:rotate", "--to", "2"], (l) => lines.push(l))).toBe(0);
      expect(lines.join("\n")).toMatch(/re-wrapped 2 credential\(s\)/);
      expect(await cli(["keys:rotate"], (l) => lines.push(l))).toBe(2);
      expect(await cli(["nope"], (l) => lines.push(l))).toBe(2);
      expect(await cli(["setup:token"], (l) => lines.push(l))).toBe(1);
    } finally {
      process.env = saved;
    }
  });
});

describe("misc", () => {
  it("health, ready, 404 JSON", async () => {
    expect((await h.app.inject("/api/health")).json()).toEqual({ ok: true });
    expect((await h.app.inject("/api/ready")).json()).toEqual({ ok: true });
    expect((await h.app.inject("/api/nope")).json()).toMatchObject({ error: { code: "not_found" } });
  });

  it("owner role is seeded with *", async () => {
    const [owner] = await h.deps.db.select().from(roles).where(and(eq(roles.storeId, storeId), eq(roles.key, "owner")));
    expect(owner!.isSystem).toBe(true);
  });
});
