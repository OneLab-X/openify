import { beginSetup, launchStore, saveOwnerStep, saveStorageStep, saveStoreStep } from "@shopkit/core";
import type { LightMyRequestResponse } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Jar, makeHarness, STRONG, type Harness } from "./harness.js";

let h: Harness;
beforeAll(async () => {
  h = await makeHarness();
});
afterAll(() => h.close());
beforeEach(async () => {
  await h.reset();
  await beginSetup(h.deps);
  const actor = { type: "setup" as const };
  await saveOwnerStep(h.deps, actor, { name: "Asha", email: "asha@pls.test", password: STRONG });
  await saveStorageStep(h.deps, actor, { provider: "local", mode: "live" });
  await saveStoreStep(h.deps, actor, { name: "PLS", email: "hello@pls.test", country: "IN", currency: "INR", timezone: "UTC", locale: "en-IN", weightUnit: "kg", publicUrl: "https://shop.test" });
  await launchStore(h.deps, actor);
});

type Call = (method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE", url: string, payload?: unknown) => Promise<LightMyRequestResponse>;
async function admin(): Promise<Call> {
  const jar = new Jar();
  const res = jar.absorb(await h.app.inject({ method: "POST", url: "/api/admin/auth/login", payload: { email: "asha@pls.test", password: STRONG } }));
  const csrf = res.json<{ csrf: string }>().csrf;
  return (method, url, payload) => h.app.inject({ method, url, payload: payload as never, headers: { cookie: jar.header, "x-csrf-token": csrf } });
}
const sf = (method: "GET" | "POST", url: string, payload?: unknown, headers: Record<string, string> = { "x-shopkit-client": "storefront" }) => h.app.inject({ method, url, payload: payload as never, headers });

describe("content API", () => {
  it("theme editor: draft, preview with a token, publish, rollback", async () => {
    const a = await admin();
    const state = await a("GET", "/api/admin/theme");
    expect(state.statusCode).toBe(200);
    const index = state.json<{ templates: { index: { order: string[] } } }>().templates.index;
    const reordered = { ...index, order: [...index.order].reverse() };
    expect((await a("PUT", "/api/admin/theme/draft", { templates: { index: reordered } })).json()).toEqual({ issues: {} });

    const live = await sf("GET", "/api/storefront/theme?template=index");
    expect(live.headers["cache-control"]).toMatch(/^public/);
    expect(live.json<{ template: { order: string[] } }>().template.order).toEqual(index.order);
    const { token } = (await a("POST", "/api/admin/theme/preview-token")).json<{ token: string }>();
    const preview = await sf("GET", `/api/storefront/theme?template=index&preview=${encodeURIComponent(token)}`);
    expect(preview.headers["cache-control"]).toBe("private, no-store");
    expect(preview.json()).toMatchObject({ draft: true, template: { order: reordered.order } });
    expect((await sf("GET", "/api/storefront/theme?template=index&preview=forged.1.x")).statusCode).toBe(403);

    expect((await a("POST", "/api/admin/theme/publish", { note: "Reordered" })).json()).toEqual({ version: 2 });
    expect((await sf("GET", "/api/storefront/theme?template=index")).json<{ template: { order: string[] } }>().template.order).toEqual(reordered.order);
    expect((await a("POST", "/api/admin/theme/rollback", { version: 1 })).json()).toEqual({ version: 3 });
    expect((await a("PUT", "/api/admin/theme/draft", { templates: { product: { sections: {}, order: [] } } })).statusCode).toBe(422);
  });

  it("pages, policies, blogs, menus, redirects and sitemaps", async () => {
    const a = await admin();
    const page = (await a("POST", "/api/admin/pages", { title: "About", bodyHtml: "<p>Hi<script>x</script></p>" })).json<{ id: string; bodyHtml: string }>();
    expect(page.bodyHtml).toBe("<p>Hi</p>");
    expect((await sf("GET", "/api/storefront/pages/about")).json()).toMatchObject({ title: "About", description: "Hi" });
    await a("PUT", `/api/admin/pages/${page.id}`, { title: "About", handle: "about-us", bodyHtml: "<p>Hi</p>" });
    expect((await sf("GET", "/api/storefront/redirect?path=/pages/about")).json()).toEqual({ to: "/pages/about-us" });
    expect((await a("POST", "/api/admin/policies/refund/generate", {})).json()).toMatchObject({ url: "/policies/refund-policy" });
    expect((await sf("GET", "/api/storefront/policies")).json()).toEqual({ items: [{ title: "Refund policy", url: "/policies/refund-policy" }] });

    const blog = (await a("POST", "/api/admin/blogs", { title: "Journal" })).json<{ id: string }>();
    await a("POST", "/api/admin/articles", { blogId: blog.id, title: "Hello world", bodyHtml: "<p>First post</p>", published: true });
    expect((await sf("GET", "/api/storefront/blogs/journal")).json()).toMatchObject({ items: [{ title: "Hello world", url: "/blogs/journal/hello-world" }] });
    expect((await sf("GET", "/api/storefront/blogs/journal/articles/hello-world")).statusCode).toBe(200);

    const menus = (await a("GET", "/api/admin/menus")).json<{ items: { id: string; handle: string }[] }>().items;
    const main = menus.find((m) => m.handle === "main-menu")!;
    await a("PUT", `/api/admin/menus/${main.id}`, { title: "Main menu", handle: "main-menu", items: [{ title: "About", kind: "page", resourceId: page.id }] });
    expect((await sf("GET", "/api/storefront/menus/main-menu")).json()).toEqual({ items: [{ title: "About", url: "/pages/about-us", items: [] }] });

    expect((await a("POST", "/api/admin/redirects", { fromPath: "/old", toPath: "/pages/about-us" })).statusCode).toBe(200);
    expect((await a("GET", "/api/admin/redirects?query=old")).json()).toMatchObject({ total: 1 });

    expect((await sf("GET", "/api/storefront/sitemap")).json()).toEqual({ items: [{ type: "pages", pages: 1 }, { type: "blogs", pages: 1 }] });
    expect((await sf("GET", "/api/storefront/sitemap/pages")).json<{ items: { path: string }[] }>().items.map((i) => i.path)).toEqual(["/", "/collections", "/pages/about-us", "/policies/refund-policy"]);
  });

  it("analytics config, first-party events and newsletter need the client header", async () => {
    expect((await sf("GET", "/api/storefront/analytics")).json()).toEqual({ consentBanner: true, providers: [] });
    expect((await sf("POST", "/api/storefront/events", { sessionId: "sess_12345678", events: [{ name: "page_view", path: "/" }] }, {})).statusCode).toBe(403);
    expect((await sf("POST", "/api/storefront/events", { sessionId: "sess_12345678", events: [{ name: "page_view", path: "/" }] })).json()).toEqual({ accepted: 1 });
    expect((await sf("POST", "/api/storefront/newsletter", { email: "fan@example.com" })).json()).toEqual({ ok: true });
    expect((await sf("POST", "/api/storefront/newsletter", { email: "nope" })).statusCode).toBe(422);
  });
});
