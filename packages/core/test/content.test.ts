import { analyticsDaily, and, eq, outboxEvents, redirects } from "@shopkit/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createProduct, updateProduct } from "../src/catalog/products.js";
import { upsertCredential } from "../src/credentials.js";
import { analyticsConfig, recordEvents, subscribeNewsletter } from "../src/content/analytics.js";
import { listMenus, saveMenu, storefrontMenu } from "../src/content/menus.js";
import { generatePolicy, saveArticle, saveBlog, savePage, storefrontArticle, storefrontBlog, storefrontPage, storefrontPolicies } from "../src/content/pages.js";
import { deleteRedirect, findRedirect, listRedirects, normalizePath, saveRedirect } from "../src/content/redirects.js";
import { createPreviewToken, publishTheme, rollbackTheme, saveThemeDraft, storefrontTheme, themeEditorState, verifyPreviewToken } from "../src/content/themes.js";
import { routeOutboxEvent } from "../src/outbox-routes.js";
import { rollupAnalyticsDay } from "../src/reports.js";
import { setSetting } from "../src/settings.js";
import { makeStore, teeInput } from "./catalog-fixtures.js";
import { ACTOR, makeDeps, type TestDeps } from "./harness.js";

let deps: TestDeps;
let storeId: string;
beforeAll(async () => {
  deps = await makeDeps();
});
afterAll(() => deps.close());
beforeEach(async () => {
  await deps.reset();
  storeId = await makeStore(deps);
});

describe("themes", () => {
  it("creates the default theme, saves drafts without touching live, publishes a version and rolls back", async () => {
    const state = await themeEditorState(deps, storeId);
    expect(state.theme.publishedVersion).toBe(1);
    expect(state.templates.index.order).toEqual(["hero", "featured", "story", "testimonials", "newsletter"]);
    expect((await listMenus(deps.db, storeId)).map((m) => m.handle).sort()).toEqual(["footer", "main-menu"]);

    // Move the newsletter to the top, inject a script into rich text, add an unknown section.
    const index = structuredClone(state.templates.index);
    index.order = ["newsletter", ...index.order.filter((k) => k !== "newsletter"), "bogus"];
    index.sections.bogus = { type: "does-not-exist", settings: {}, blocks: {}, block_order: [] };
    index.sections.story!.settings.text = '<p>Hi</p><script>alert(1)</script><img src="x" onerror="alert(1)">';
    const saved = await saveThemeDraft(deps, ACTOR, storeId, { templates: { index }, settings: { color_accent: "#FF0000", font_body: "comic-sans" } });
    expect(saved.issues.index?.map((i) => i.path)).toEqual(["sections.bogus"]);

    const live = await storefrontTheme(deps, storeId, "index");
    expect(live.template.order[0]).toBe("hero");
    const draft = await storefrontTheme(deps, storeId, "index", { draft: true });
    expect(draft.template.order[0]).toBe("newsletter");
    expect(draft.template.sections.story!.settings.text).toBe("<p>Hi</p>");
    expect(draft.settings).toEqual({ color_accent: "#ff0000", font_body: "system" });

    await expect(saveThemeDraft(deps, ACTOR, storeId, { templates: { product: { sections: {}, order: [] } } })).rejects.toThrow(/Product information/);

    const { version } = await publishTheme(deps, ACTOR, storeId, { note: "Newsletter first" });
    expect(version).toBe(2);
    expect((await storefrontTheme(deps, storeId, "index")).template.order[0]).toBe("newsletter");
    expect((await themeEditorState(deps, storeId)).hasDraft).toBe(false);
    const [ev] = await deps.db.select().from(outboxEvents).where(eq(outboxEvents.type, "theme.published"));
    const jobs = await routeOutboxEvent(deps, { id: ev!.id, storeId, type: ev!.type, payload: ev!.payload, attempts: 0, createdAt: ev!.createdAt });
    expect(jobs).toEqual([expect.objectContaining({ queue: "revalidate", data: { storeId, tags: ["theme"] } })]);

    const rolled = await rollbackTheme(deps, ACTOR, storeId, 1);
    expect(rolled.version).toBe(3);
    expect((await storefrontTheme(deps, storeId, "index")).template.order[0]).toBe("hero");
    expect((await themeEditorState(deps, storeId)).versions.map((v) => v.note)).toEqual(["Rollback to version 1", "Newsletter first", "Default theme"]);
  });

  it("signs preview tokens per store with an expiry", () => {
    const token = createPreviewToken(deps, storeId);
    expect(verifyPreviewToken(deps, token)).toBe(storeId);
    expect(verifyPreviewToken(deps, `${token.slice(0, -2)}xx`)).toBeNull();
    expect(verifyPreviewToken({ ...deps, now: () => new Date(Date.now() + 3 * 3600_000) }, token)).toBeNull();
  });
});

describe("pages, blogs, menus and redirects", () => {
  it("sanitises page HTML, redirects old handles, generates policies", async () => {
    const page = await savePage(deps, ACTOR, storeId, { title: "About us", bodyHtml: '<h2>Hello</h2><p onclick="x()">We <a href="javascript:alert(1)">make</a> things</p><script>bad()</script>' });
    expect(page).toMatchObject({ handle: "about-us", url: "/pages/about-us", bodyHtml: "<h2>Hello</h2><p>We <a>make</a> things</p>" });
    await savePage(deps, ACTOR, storeId, { title: "About", handle: "our-story", bodyHtml: page.bodyHtml }, page.id);
    expect(await findRedirect(deps.db, storeId, "/pages/About-Us/")).toBe("/pages/our-story");
    expect(await storefrontPage(deps.db, storeId, "our-story", "page")).toMatchObject({ title: "About", description: "Hello We make things" });

    const privacy = await generatePolicy(deps, ACTOR, storeId, "privacy");
    expect(privacy).toMatchObject({ kind: "policy", handle: "privacy-policy", url: "/policies/privacy-policy" });
    expect(privacy.bodyHtml).toContain("PLS");
    await expect(generatePolicy(deps, ACTOR, storeId, "privacy")).rejects.toThrow(/already exists/);
    await generatePolicy(deps, ACTOR, storeId, "refund");
    expect(await storefrontPolicies(deps.db, storeId)).toEqual([
      { title: "Privacy policy", url: "/policies/privacy-policy" },
      { title: "Refund policy", url: "/policies/refund-policy" },
    ]);
  });

  it("blogs and articles: only published posts show, renamed blog redirects its posts", async () => {
    const blog = await saveBlog(deps, ACTOR, storeId, { title: "News" });
    const post = await saveArticle(deps, ACTOR, storeId, { blogId: blog.id, title: "Diwali drop", bodyHtml: "<p>New candles are here.</p>", published: true, tags: ["launch"] });
    await saveArticle(deps, ACTOR, storeId, { blogId: blog.id, title: "Draft", published: false });
    const list = await storefrontBlog(deps, storeId, "news");
    expect(list?.items.map((a) => a.title)).toEqual(["Diwali drop"]);
    expect(list?.items[0]!.excerpt).toBe("New candles are here.");
    expect(await storefrontArticle(deps, storeId, "news", "draft")).toBeNull();
    await saveBlog(deps, ACTOR, storeId, { title: "Journal", handle: "journal" }, blog.id);
    expect(await findRedirect(deps.db, storeId, "/blogs/news/diwali-drop")).toBe("/blogs/journal/diwali-drop");
    expect((await storefrontArticle(deps, storeId, "journal", post.handle))?.url).toBe("/blogs/journal/diwali-drop");
  });

  it("product handle changes redirect without chains; manual redirects validate", async () => {
    const p = await createProduct(deps, ACTOR, storeId, teeInput({ handle: "tee-a" }));
    await updateProduct(deps, ACTOR, storeId, p.id, { ...teeInput(), handle: "tee-b" });
    await updateProduct(deps, ACTOR, storeId, p.id, { ...teeInput(), handle: "tee-c" });
    expect(await findRedirect(deps.db, storeId, "/products/tee-a")).toBe("/products/tee-c");
    expect(await findRedirect(deps.db, storeId, "/products/tee-b")).toBe("/products/tee-c");
    // Renaming back makes the old URL live again: its redirect goes away.
    await updateProduct(deps, ACTOR, storeId, p.id, { ...teeInput(), handle: "tee-a" });
    expect(await findRedirect(deps.db, storeId, "/products/tee-a")).toBeNull();
    expect(await deps.db.$count(redirects, and(eq(redirects.storeId, storeId), eq(redirects.automatic, true)))).toBe(2);

    expect(normalizePath("https://shop.test/Sale/?utm=1")).toBe("/sale");
    const r = await saveRedirect(deps, ACTOR, storeId, { fromPath: "/Sale/", toPath: "/collections/sale" });
    await expect(saveRedirect(deps, ACTOR, storeId, { fromPath: "/sale", toPath: "/x" })).rejects.toThrow(/already redirects/);
    await expect(saveRedirect(deps, ACTOR, storeId, { fromPath: "/a", toPath: "//evil.example" })).rejects.toThrow();
    expect((await listRedirects(deps.db, storeId, { query: "sale" })).items).toHaveLength(1);
    await deleteRedirect(deps, ACTOR, storeId, r.id);
    expect(await findRedirect(deps.db, storeId, "/sale")).toBeNull();
  });

  it("menus nest three levels and resolve links to live resources only", async () => {
    const p = await createProduct(deps, ACTOR, storeId, teeInput({ handle: "tee", status: "active" }));
    const page = await savePage(deps, ACTOR, storeId, { title: "Contact" });
    const hidden = await savePage(deps, ACTOR, storeId, { title: "Hidden", published: false });
    await saveMenu(deps, ACTOR, storeId, {
      title: "Main",
      handle: "main-menu",
      items: [
        { title: "Shop", kind: "collections", items: [{ title: "Tee", kind: "product", resourceId: p.id, items: [{ title: "Contact", kind: "page", resourceId: page.id }] }] },
        { title: "Hidden", kind: "page", resourceId: hidden.id },
        { title: "Blog", kind: "url", url: "https://blog.example.com" },
      ],
    });
    expect(await storefrontMenu(deps.db, storeId, "main-menu")).toEqual([
      { title: "Shop", url: "/collections", items: [{ title: "Tee", url: "/products/tee", items: [{ title: "Contact", url: "/pages/contact", items: [] }] }] },
      { title: "Blog", url: "https://blog.example.com", items: [] },
    ]);
    await expect(saveMenu(deps, ACTOR, storeId, { title: "Deep", items: [{ title: "1", kind: "home", items: [{ title: "2", kind: "home", items: [{ title: "3", kind: "home", items: [{ title: "4", kind: "home" }] }] }] }] })).rejects.toThrow(/three levels/);
  });
});

describe("analytics", () => {
  it("records first-party events and rolls sessions and page views into analytics_daily", async () => {
    await recordEvents(deps, storeId, { sessionId: "sess_aaaaaaaa", events: [{ name: "page_view", path: "/?utm=x" }, { name: "page_view", path: "/products/tee" }, { name: "view_item" }] });
    await recordEvents(deps, storeId, { sessionId: "sess_bbbbbbbb", events: [{ name: "page_view", path: "/" }] });
    await expect(recordEvents(deps, storeId, { sessionId: "x", events: [{ name: "page_view" }] })).rejects.toThrow();
    const day = new Date().toISOString().slice(0, 10);
    await rollupAnalyticsDay(deps.db, storeId, day);
    const [row] = await deps.db.select().from(analyticsDaily).where(and(eq(analyticsDaily.storeId, storeId), eq(analyticsDaily.day, day)));
    expect(row).toMatchObject({ sessions: 2, pageViews: 3 });
  });

  it("gates consent-requiring snippets behind the banner and routes server events per provider", async () => {
    await upsertCredential(deps, ACTOR, { storeId, kind: "analytics", provider: "ga4", mode: "live" }, { config: { measurementId: "G-TEST1234" }, secrets: { apiSecret: "secret1234" } });
    await upsertCredential(deps, ACTOR, { storeId, kind: "analytics", provider: "plausible", mode: "live" }, { config: { domain: "shop.test" }, secrets: {} });
    const on = await analyticsConfig(deps, storeId);
    expect(on.consentBanner).toBe(true);
    expect(on.providers.map((p) => [p.id, p.requiresConsent]).sort()).toEqual([["ga4", true], ["plausible", false]]);
    await setSetting(deps.db, storeId, "analytics.consentBanner", false);
    expect((await analyticsConfig(deps, storeId)).providers.map((p) => p.id)).toEqual(["plausible"]);

    const jobs = await routeOutboxEvent(deps, { id: "e1", storeId, type: "order.paid", payload: { orderId: "00000000-0000-0000-0000-000000000000" }, attempts: 0, createdAt: new Date() });
    expect(jobs.filter((j) => j.queue === "analytics").map((j) => j.data.provider).sort()).toEqual(["ga4", "plausible"]);
  });

  it("newsletter signups create or opt in a customer", async () => {
    await subscribeNewsletter(deps, storeId, { email: "Fan@Example.com" });
    await subscribeNewsletter(deps, storeId, { email: "fan@example.com" });
    const { customers } = await import("@shopkit/db");
    const rows = await deps.db.select().from(customers).where(eq(customers.storeId, storeId));
    expect(rows).toEqual([expect.objectContaining({ email: "fan@example.com", marketingConsent: true })]);
  });
});
