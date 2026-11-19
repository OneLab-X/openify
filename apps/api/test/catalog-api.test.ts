import { beginSetup, ensureSystemRoles, hashPassword, launchStore, processMedia, runJob, saveOwnerStep, saveStorageStep, saveStoreStep } from "@shopkit/core";
import { staffUsers } from "@shopkit/db";
import { localStorage } from "@shopkit/providers";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Jar, makeHarness, multipart, STRONG, type Harness } from "./harness.js";

let h: Harness;
let storeId: string;
beforeAll(async () => {
  h = await makeHarness();
});
afterAll(() => h.close());

async function setup(launch = true) {
  await h.reset();
  storeId = await beginSetup(h.deps);
  const actor = { type: "setup" as const };
  await saveOwnerStep(h.deps, actor, { name: "Asha", email: "asha@pls.test", password: STRONG });
  await saveStorageStep(h.deps, actor, { provider: "local", mode: "live" });
  await saveStoreStep(h.deps, actor, {
    name: "PLS", email: "hello@pls.test", country: "IN", currency: "INR", timezone: "UTC", locale: "en-IN", weightUnit: "kg", publicUrl: "https://shop.test",
  });
  if (launch) await launchStore(h.deps, actor);
}
beforeEach(() => setup());

async function signIn(email = "asha@pls.test") {
  const jar = new Jar();
  const res = jar.absorb(await h.app.inject({ method: "POST", url: "/api/admin/auth/login", payload: { email, password: STRONG } }));
  const csrf = res.json<{ csrf: string }>().csrf;
  return (method: "GET" | "PUT" | "POST" | "PATCH" | "DELETE", url: string, payload?: unknown, extra: Record<string, string> = {}) =>
    h.app.inject({ method, url, payload: payload as never, headers: { cookie: jar.header, "x-csrf-token": csrf, ...extra } });
}

const tee = {
  title: "Block Print Tee",
  status: "active",
  descriptionHtml: "<p>Soft</p><script>x()</script>",
  tags: ["cotton"],
  options: [
    { name: "Size", values: ["S", "M", "L"] },
    { name: "Colour", values: ["Red", "Blue"] },
  ],
  variants: ["S", "M", "L"].flatMap((s) => ["Red", "Blue"].map((c) => ({ options: [s, c], price: 99_900, cost: 40_000, sku: `T-${s}-${c}` }))),
};

const png = () => sharp({ create: { width: 800, height: 600, channels: 3, background: "#8e44ad" } }).png().toBuffer();

describe("admin catalog API", () => {
  it("requires a session and products permissions", async () => {
    expect((await h.app.inject({ method: "GET", url: "/api/admin/products" })).statusCode).toBe(401);
    await ensureSystemRoles(h.deps.db, storeId);
    const { roles, rolePermissions } = await import("@shopkit/db");
    const [viewer] = await h.deps.db.insert(roles).values({ storeId, key: "viewer", name: "Viewer" }).returning();
    await h.deps.db.insert(rolePermissions).values({ storeId, roleId: viewer!.id, permission: "products:read" });
    await h.deps.db.insert(staffUsers).values({ storeId, roleId: viewer!.id, name: "V", email: "v@pls.test", passwordHash: await hashPassword(STRONG) });
    const call = await signIn("v@pls.test");
    expect((await call("GET", "/api/admin/products")).statusCode).toBe(200);
    expect((await call("POST", "/api/admin/products", tee)).statusCode).toBe(403);
  });

  it("creates, lists, updates and deletes products", async () => {
    const call = await signIn();
    const created = await call("POST", "/api/admin/products", tee);
    expect(created.statusCode).toBe(200);
    const p = created.json<{ id: string; handle: string; variants: { id: string }[]; descriptionHtml: string }>();
    expect(p.handle).toBe("block-print-tee");
    expect(p.variants).toHaveLength(6);
    expect(p.descriptionHtml).toBe("<p>Soft</p>");

    const bad = await call("POST", "/api/admin/products", { ...tee, variants: [{ options: ["S"], price: 1 }] });
    expect(bad.statusCode).toBe(422);
    expect(bad.json()).toMatchObject({ error: { details: [expect.objectContaining({ path: "variants.0.options" })] } });

    const list = await call("GET", "/api/admin/products?q=tee&status=active");
    expect(list.json()).toMatchObject({ items: [{ id: p.id, variantsCount: 6, priceMin: 99_900 }], nextCursor: null });
    expect((await call("GET", "/api/admin/catalog/facets")).json()).toMatchObject({ tags: ["cotton"] });

    const updated = await call("PUT", `/api/admin/products/${p.id}`, { ...tee, title: "Tee 2", handle: "tee-two" });
    expect(updated.json()).toMatchObject({ title: "Tee 2", handle: "tee-two" });
    expect((await call("POST", "/api/admin/products/bulk", { ids: [p.id], action: { type: "set_status", status: "archived" } })).json()).toEqual({ updated: 1 });
    expect((await call("DELETE", `/api/admin/products/${p.id}`)).statusCode).toBe(200);
    expect((await call("GET", `/api/admin/products/${p.id}`)).statusCode).toBe(404);
  });

  it("saved views", async () => {
    const call = await signIn();
    const view = (await call("POST", "/api/admin/product-views", { name: "Drafts", filters: { status: "draft" } })).json<{ id: string }>();
    expect((await call("GET", "/api/admin/product-views")).json()).toEqual([expect.objectContaining({ name: "Drafts", filters: { status: "draft" } })]);
    await call("DELETE", `/api/admin/product-views/${view.id}`);
    expect((await call("GET", "/api/admin/product-views")).json()).toEqual([]);
  });

  it("uploads media through the API and serves renditions via /media", async () => {
    const call = await signIn();
    const target = await call("POST", "/api/admin/media/uploads", { filename: "a.png", contentType: "image/png", byteSize: 1000 });
    expect(target.json()).toEqual({ mediaId: null, upload: null }); // local disk → upload via API
    const form = multipart("file", "front.png", await png());
    const up = await call("POST", "/api/admin/media", form.payload, form.headers);
    expect(up.statusCode).toBe(200);
    const m = up.json<{ id: string; url: string }>();
    await processMedia(h.deps, m.id);
    const original = await h.app.inject({ method: "GET", url: new URL(m.url).pathname });
    expect(original.statusCode).toBe(200);
    expect(original.headers["content-type"]).toBe("image/png");
    const webp = await h.app.inject({ method: "GET", url: `/media/${m.id}/w640.webp` });
    expect(webp.statusCode).toBe(200);
    expect(webp.headers["content-type"]).toBe("image/webp");
    expect(webp.headers["cache-control"]).toContain("immutable");
    expect((await h.app.inject({ method: "GET", url: `/media/${m.id}/w641.webp` })).statusCode).toBe(404);

    const alt = await call("PATCH", `/api/admin/media/${m.id}`, { alt: "Front view" });
    expect(alt.json()).toMatchObject({ alt: "Front view", processed: true, sources: expect.arrayContaining([expect.objectContaining({ width: 640, format: "avif" })]) });

    const product = await call("POST", "/api/admin/products", { ...tee, mediaIds: [m.id], variants: tee.variants.map((v, i) => ({ ...v, imageMediaId: i === 0 ? m.id : null })) });
    expect(product.json()).toMatchObject({ media: [{ id: m.id }] });
    expect(product.json<{ variants: { imageMediaId: string | null }[] }>().variants[0]!.imageMediaId).toBe(m.id);
    expect((await call("DELETE", `/api/admin/media/${m.id}`)).statusCode).toBe(200);
    const text = multipart("file", "x.txt", Buffer.from("hello"), "text/plain");
    expect((await call("POST", "/api/admin/media", text.payload, text.headers)).statusCode).toBe(422);
  });

  it("serves signed /media/s URLs and rejects tampering", async () => {
    const provider = localStorage.create({ storeId, mode: "live", config: { subdirectory: "media" }, secrets: {}, runtime: h.deps.runtime });
    await provider.put("private/doc.txt", Buffer.from("secret"), { contentType: "text/plain" });
    const url = new URL(await provider.getSignedUrl("private/doc.txt", { expiresIn: 60 }));
    const ok = await h.app.inject({ method: "GET", url: url.pathname + url.search });
    expect(ok.statusCode).toBe(200);
    expect(ok.body).toBe("secret");
    expect((await h.app.inject({ method: "GET", url: url.pathname.replace("doc", "doc2") + url.search })).statusCode).toBe(403);
    expect((await h.app.inject({ method: "GET", url: url.pathname + url.search.replace(/sig=../, "sig=00") })).statusCode).toBe(403);
  });

  it("collections, locations and inventory", async () => {
    const call = await signIn();
    const p = (await call("POST", "/api/admin/products", tee)).json<{ id: string; variants: { inventoryItemId: string }[] }>();
    const smart = await call("POST", "/api/admin/collections", { title: "Cotton", type: "smart", rules: { match: "all", conditions: [{ field: "tag", relation: "equals", value: "cotton" }] } });
    expect(smart.json()).toMatchObject({ handle: "cotton", productsCount: 1, sortOrder: "best_selling" });
    const manual = await call("POST", "/api/admin/collections", { title: "Picks", sortOrder: "manual", productIds: [p.id] });
    expect(manual.json()).toMatchObject({ type: "manual", products: [{ id: p.id }] });
    expect((await call("GET", "/api/admin/collections")).json()).toHaveLength(2);
    expect((await call("POST", "/api/admin/collections", { title: "Bad", type: "smart" })).statusCode).toBe(422);

    const loc = (await call("POST", "/api/admin/locations", { name: "Warehouse" })).json<{ id: string; isDefault: boolean }>();
    expect(loc.isDefault).toBe(true); // ship-from was not set in setup, so the first location is the default
    expect((await call("GET", "/api/admin/locations")).json()).toHaveLength(1);
    const adj = await call("POST", "/api/admin/inventory/adjustments", { reason: "received", changes: [{ inventoryItemId: p.variants[0]!.inventoryItemId, locationId: loc.id, delta: 5 }] });
    expect(adj.json()).toEqual({ productIds: [p.id] });
    const inv = await call("GET", `/api/admin/inventory?locationId=${loc.id}`);
    expect(inv.json<{ items: { available: number }[] }>().items[0]!.available).toBe(5);
    const history = await call("GET", `/api/admin/inventory/items/${p.variants[0]!.inventoryItemId}/adjustments`);
    expect(history.json()).toEqual([expect.objectContaining({ reason: "received", delta: 5, locationName: "Warehouse" })]);
  });

  it("imports a Shopify CSV as a job with an error report, and exports", async () => {
    const call = await signIn();
    const csv = [
      "Handle,Title,Option1 Name,Option1 Value,Variant Price,Status",
      "kurta,Kurta,Size,S,1200.00,active",
      "kurta,,,M,1250.00,",
      "broken,Broken,Size,S,abc,active",
    ].join("\n");
    const form = multipart("file", "products.csv", Buffer.from(csv), "text/csv");
    const res = await call("POST", "/api/admin/products/import", form.payload, form.headers);
    expect(res.statusCode).toBe(200);
    const job = res.json<{ id: string; status: string }>();
    expect(job.status).toBe("queued");
    await runJob(h.deps, job.id);
    const done = (await call("GET", `/api/admin/jobs/${job.id}`)).json();
    expect(done).toMatchObject({ status: "completed", processed: 1, total: 1, errorCount: 1, result: { created: 1 }, errors: [{ ref: "broken" }] });
    const report = await call("GET", `/api/admin/jobs/${job.id}/errors.csv`);
    expect(report.headers["content-type"]).toContain("text/csv");
    expect(report.body).toContain("broken");

    const exp = (await call("POST", "/api/admin/products/export", { filter: { status: "active" } })).json<{ id: string }>();
    expect((await call("GET", `/api/admin/jobs/${exp.id}/download`)).statusCode).toBe(409);
    await runJob(h.deps, exp.id);
    const file = await call("GET", `/api/admin/jobs/${exp.id}/download`);
    expect(file.headers["content-disposition"]).toMatch(/attachment; filename="products-.*\.csv"/);
    expect(file.body).toContain("kurta,Kurta");
    expect((await call("GET", "/api/admin/jobs?type=product_import")).json()).toHaveLength(1);
  });
});

describe("storefront API", () => {
  it("is closed until launch", async () => {
    await setup(false);
    const res = await h.app.inject({ method: "GET", url: "/api/storefront/products" });
    expect(res.statusCode).toBe(409);
  });

  it("serves products, collections, facets and search with cache headers", async () => {
    const call = await signIn();
    const p = (await call("POST", "/api/admin/products", tee)).json<{ id: string }>();
    await call("POST", "/api/admin/products", { title: "Draft thing", variants: [{ price: 1 }] });
    await call("POST", "/api/admin/collections", { title: "Summer", sortOrder: "price_asc", productIds: [p.id] });

    const list = await h.app.inject({ method: "GET", url: "/api/storefront/products?limit=10" });
    expect(list.statusCode).toBe(200);
    expect(list.headers["cache-control"]).toBe("public, max-age=30, stale-while-revalidate=300");
    expect(list.json()).toMatchObject({ items: [{ handle: "block-print-tee", available: false }], nextCursor: null });

    const product = await h.app.inject({ method: "GET", url: "/api/storefront/products/Block-Print-Tee" });
    expect(product.json()).toMatchObject({ title: "Block Print Tee", variants: expect.arrayContaining([expect.objectContaining({ title: "S / Red" })]) });
    expect(product.body).not.toContain("cost");
    expect((await h.app.inject({ method: "GET", url: "/api/storefront/products/draft-thing" })).statusCode).toBe(404);

    const filtered = await h.app.inject({ method: "GET", url: "/api/storefront/collections/summer/products?option=Size:M&option=Colour:Blue&priceMin=1000" });
    expect(filtered.json()).toMatchObject({ items: [{ id: p.id }] });
    const none = await h.app.inject({ method: "GET", url: "/api/storefront/collections/summer/products?option=Size:XXL" });
    expect(none.json()).toEqual({ items: [], nextCursor: null });
    expect((await h.app.inject({ method: "GET", url: "/api/storefront/collections" })).json()).toMatchObject({ items: [{ handle: "summer", productsCount: 1 }] });
    expect((await h.app.inject({ method: "GET", url: "/api/storefront/facets?collection=summer" })).json()).toMatchObject({ tags: [{ value: "cotton", count: 1 }] });
    expect((await h.app.inject({ method: "GET", url: "/api/storefront/search?q=print" })).json()).toMatchObject({ total: 1, items: [{ id: p.id }] });
    expect((await h.app.inject({ method: "GET", url: "/api/storefront/search?q=" })).statusCode).toBe(422);
  });
});
