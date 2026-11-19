import { inventoryAdjustments, media, outboxEvents, products, productVariants, sql } from "@shopkit/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  addProductsToCollection,
  adjustInventory,
  bulkUpdateProducts,
  createCollection,
  createProduct,
  deleteProduct,
  getProductAdmin,
  listProductsAdmin,
  updateCollection,
  updateProduct,
} from "../src/index.js";
import { ensureDefaultLocation, listAdjustments, listInventory } from "../src/catalog/inventory.js";
import { getStorefrontProduct, listStorefrontProducts, searchStorefront, storefrontFacets, getStorefrontCollection } from "../src/catalog/storefront.js";
import { postgresSearch } from "../src/catalog/search.js";
import { AppError } from "../src/errors.js";
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

const events = async () => (await deps.db.select().from(outboxEvents)).map((e) => e.type);

describe("products", () => {
  it("creates a product with 2 options and 6 variants, sanitising the description", async () => {
    const p = await createProduct(deps, ACTOR, storeId, teeInput());
    expect(p.handle).toBe("block-print-tee");
    expect(p.options).toEqual([
      expect.objectContaining({ name: "Size", values: ["S", "M", "L"] }),
      expect.objectContaining({ name: "Colour", values: ["Red", "Blue"] }),
    ]);
    expect(p.variants).toHaveLength(6);
    expect(p.variants[0]).toMatchObject({ title: "S / Red", options: ["S", "Red"], price: 99_900, currency: "INR", hsnCode: "6109", weightUnit: "kg", tracked: true });
    expect(p.descriptionHtml).toBe("<p>Hand <strong>block printed</strong>.</p>");
    expect(p.priceMin).toBe(99_900);
    expect(p.priceMax).toBe(119_900);
    expect(p.available).toBe(false); // tracked, nothing in stock
    expect(p.tags).toEqual(["cotton", "summer"]);
    expect(await events()).toContain("product.created");
  });

  it("generates unique handles and rejects taken explicit ones", async () => {
    await createProduct(deps, ACTOR, storeId, teeInput());
    const second = await createProduct(deps, ACTOR, storeId, teeInput());
    expect(second.handle).toBe("block-print-tee-2");
    await expect(createProduct(deps, ACTOR, storeId, teeInput({ handle: "Block Print Tee" }))).rejects.toMatchObject({ code: "validation_failed" });
  });

  it("validates options against variants", async () => {
    const bad = teeInput();
    bad.variants[1] = { ...bad.variants[1]!, options: ["S", "Red"] };
    await expect(createProduct(deps, ACTOR, storeId, bad)).rejects.toThrow(AppError);
    await expect(createProduct(deps, ACTOR, storeId, teeInput({ variants: [{ options: ["XL", "Red"], price: 1 }] }))).rejects.toMatchObject({
      details: [expect.objectContaining({ path: "variants.0.options.0" })],
    });
    await expect(createProduct(deps, ACTOR, storeId, { title: "No opts", variants: [{ price: 1 }, { price: 2 }] })).rejects.toThrow(AppError);
    await expect(
      createProduct(deps, ACTOR, storeId, { title: "Too many", options: [1, 2, 3, 4].map((n) => ({ name: `O${n}`, values: ["a"] })), variants: [{ options: ["a", "a", "a", "a"], price: 1 }] }),
    ).rejects.toThrow();
  });

  it("keeps variant ids (and stock) across edits, including re-ordered options", async () => {
    const p = await createProduct(deps, ACTOR, storeId, teeInput());
    const location = await ensureDefaultLocation(deps.db, storeId);
    const red = p.variants.find((v) => v.title === "M / Red")!;
    await adjustInventory(deps, ACTOR, storeId, { reason: "received", changes: [{ inventoryItemId: red.inventoryItemId!, locationId: location, quantity: "available", delta: 7 }] });

    const input = teeInput({ title: "Block Print Tee v2" });
    input.variants = [...input.variants].reverse().map((v) => ({ ...v, price: v.price + 1 }));
    const updated = await updateProduct(deps, ACTOR, storeId, p.id, input);
    expect(updated.handle).toBe("block-print-tee"); // handle is stable when not given
    const again = updated.variants.find((v) => v.title === "M / Red")!;
    expect(again.id).toBe(red.id);
    expect(again.inventory).toEqual([expect.objectContaining({ locationId: location, available: 7 })]);
    expect(updated.available).toBe(true);
    expect(updated.totalInventory).toBe(7);

    // Dropping a value deletes its variants.
    const smaller = teeInput({ options: [{ name: "Size", values: ["S", "M"] }, { name: "Colour", values: ["Red", "Blue"] }] });
    smaller.variants = smaller.variants.filter((v) => v.options![0] !== "L");
    expect((await updateProduct(deps, ACTOR, storeId, p.id, smaller)).variants).toHaveLength(4);
  });

  it("sets inventory through the editor and records the ledger", async () => {
    const location = await ensureDefaultLocation(deps.db, storeId);
    const input = teeInput();
    input.variants = input.variants.map((v, i) => ({ ...v, inventory: [{ locationId: location, available: i }] }));
    const p = await createProduct(deps, ACTOR, storeId, input);
    expect(p.totalInventory).toBe(15);
    const ledger = await deps.db.select().from(inventoryAdjustments);
    expect(ledger).toHaveLength(5); // the variant set to 0 is a no-op
    expect(ledger.every((r) => r.reason === "correction")).toBe(true);
    // Same values again → no new ledger rows.
    await updateProduct(deps, ACTOR, storeId, p.id, input);
    expect(await deps.db.$count(inventoryAdjustments)).toBe(5);
  });

  it("continue-selling and untracked variants are available without stock", async () => {
    const p = await createProduct(deps, ACTOR, storeId, { title: "Gift wrap", status: "active", variants: [{ price: 5000, tracked: false }] });
    expect(p.available).toBe(true);
    const q = await createProduct(deps, ACTOR, storeId, { title: "Preorder", status: "active", variants: [{ price: 5000, inventoryPolicy: "continue" }] });
    expect(q.available).toBe(true);
  });

  it("lists with filters, search and cursors", async () => {
    for (let i = 0; i < 7; i++) {
      await createProduct(deps, ACTOR, storeId, { title: `Silk saree ${i}`, status: i % 2 ? "active" : "draft", vendor: i < 3 ? "Weaver" : "Loom", tags: [`t${i % 2}`], variants: [{ price: 1000 * (i + 1), sku: `SAR-${i}` }] });
    }
    await createProduct(deps, ACTOR, storeId, teeInput());
    const first = await listProductsAdmin(deps, storeId, { limit: 3, sort: "price_asc" });
    expect(first.items.map((p) => p.priceMin)).toEqual([1000, 2000, 3000]);
    const second = await listProductsAdmin(deps, storeId, { limit: 3, sort: "price_asc", cursor: first.nextCursor! });
    expect(second.items.map((p) => p.priceMin)).toEqual([4000, 5000, 6000]);
    expect((await listProductsAdmin(deps, storeId, { status: "active" })).items).toHaveLength(4);
    expect((await listProductsAdmin(deps, storeId, { vendor: "weaver" })).items).toHaveLength(3);
    expect((await listProductsAdmin(deps, storeId, { tag: "t1" })).items).toHaveLength(3);
    expect((await listProductsAdmin(deps, storeId, { q: "sare" })).items).toHaveLength(7); // prefix
    expect((await listProductsAdmin(deps, storeId, { q: "SAR-3" })).items.map((p) => p.title)).toEqual(["Silk saree 3"]);
    // Similar titles do not leak in when there is an exact match (typo fallback only when none).
    expect((await listProductsAdmin(deps, storeId, { q: "Silk saree 3", sort: "title_asc" })).items.map((p) => p.title)).toEqual(["Silk saree 3"]);
    expect((await listProductsAdmin(deps, storeId, { q: "blok print" })).items.map((p) => p.title)).toEqual(["Block Print Tee"]); // trigram typo
  });

  it("bulk archives, tags and deletes", async () => {
    const a = await createProduct(deps, ACTOR, storeId, teeInput());
    const b = await createProduct(deps, ACTOR, storeId, teeInput({ title: "Other" }));
    expect(await bulkUpdateProducts(deps, ACTOR, storeId, { ids: [a.id, b.id], action: { type: "add_tags", tags: ["sale"] } })).toEqual({ updated: 2 });
    expect((await getProductAdmin(deps, storeId, a.id)).tags).toContain("sale");
    await bulkUpdateProducts(deps, ACTOR, storeId, { ids: [a.id], action: { type: "remove_tags", tags: ["sale", "cotton"] } });
    expect((await getProductAdmin(deps, storeId, a.id)).tags).toEqual(["summer"]);
    await bulkUpdateProducts(deps, ACTOR, storeId, { ids: [a.id, b.id], action: { type: "set_status", status: "archived" } });
    expect((await listProductsAdmin(deps, storeId, { status: "archived" })).items).toHaveLength(2);
    await bulkUpdateProducts(deps, ACTOR, storeId, { ids: [b.id], action: { type: "delete" } });
    await deleteProduct(deps, ACTOR, storeId, a.id);
    expect(await deps.db.$count(products)).toBe(0);
    expect(await deps.db.$count(productVariants)).toBe(0);
    expect((await events()).filter((e) => e === "product.deleted")).toHaveLength(2);
  });

  it("stores and validates metafields", async () => {
    const p = await createProduct(deps, ACTOR, storeId, teeInput({ metafields: [{ namespace: "care", key: "wash", type: "single_line_text", value: "Cold" }, { namespace: "spec", key: "gsm", type: "number_integer", value: "180" }] }));
    expect(p.metafields).toEqual([
      { namespace: "care", key: "wash", type: "single_line_text", value: "Cold" },
      { namespace: "spec", key: "gsm", type: "number_integer", value: 180 },
    ]);
    await expect(updateProduct(deps, ACTOR, storeId, p.id, teeInput({ metafields: [{ namespace: "spec", key: "gsm", type: "number_integer", value: "lots" }] }))).rejects.toThrow(AppError);
    const kept = await updateProduct(deps, ACTOR, storeId, p.id, teeInput());
    expect(kept.metafields).toHaveLength(2);
  });
});

describe("inventory", () => {
  it("adjusts available/committed/incoming per location with a ledger", async () => {
    const p = await createProduct(deps, ACTOR, storeId, teeInput());
    const main = await ensureDefaultLocation(deps.db, storeId);
    const { createLocation } = await import("../src/catalog/inventory.js");
    const second = await createLocation(deps, ACTOR, storeId, { name: "Warehouse" });
    const item = p.variants[0]!.inventoryItemId!;
    await adjustInventory(deps, ACTOR, storeId, {
      reason: "received",
      note: "PO-1",
      changes: [
        { inventoryItemId: item, locationId: main, quantity: "available", delta: 10 },
        { inventoryItemId: item, locationId: second.id, quantity: "available", set: 4 },
        { inventoryItemId: item, locationId: second.id, quantity: "incoming", set: 20 },
      ],
    });
    await adjustInventory(deps, ACTOR, storeId, { reason: "damaged", changes: [{ inventoryItemId: item, locationId: main, quantity: "available", delta: -3 }] });
    const page = await listInventory(deps.db, storeId, { locationId: second.id });
    expect(page.items.find((r) => r.inventoryItemId === item)).toMatchObject({ available: 4, incoming: 20, committed: 0 });
    const history = await listAdjustments(deps.db, storeId, item, { limit: 10 });
    expect(history.map((h) => [h.reason, h.quantity, h.delta, h.quantityAfter])).toEqual([
      ["damaged", "available", -3, 7],
      ["received", "incoming", 20, 20],
      ["received", "available", 4, 4],
      ["received", "available", 10, 10],
    ]);
    expect((await getProductAdmin(deps, storeId, p.id)).totalInventory).toBe(11);
    expect((await events()).filter((e) => e === "product.updated").length).toBeGreaterThanOrEqual(2);
  });

  it("rejects items and locations of another store", async () => {
    const p = await createProduct(deps, ACTOR, storeId, teeInput());
    const other = await makeStore(deps);
    const otherLoc = await ensureDefaultLocation(deps.db, other);
    await expect(
      adjustInventory(deps, ACTOR, other, { reason: "correction", changes: [{ inventoryItemId: p.variants[0]!.inventoryItemId!, locationId: otherLoc, quantity: "available", set: 1 }] }),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("collections", () => {
  it("smart collections follow their rules (all/any) as products change", async () => {
    const tee = await createProduct(deps, ACTOR, storeId, teeInput());
    const saree = await createProduct(deps, ACTOR, storeId, { title: "Silk saree", status: "active", vendor: "Weaver", productType: "Saree", tags: ["silk"], variants: [{ price: 500_000 }] });
    const all = await createCollection(deps, ACTOR, storeId, {
      title: "Cheap cotton",
      type: "smart",
      sortOrder: "price_asc",
      rules: { match: "all", conditions: [{ field: "tag", relation: "equals", value: "COTTON" }, { field: "price", relation: "less_than", value: "100000" }] },
    });
    expect(all.products.map((p) => p.id)).toEqual([tee.id]);
    const any = await createCollection(deps, ACTOR, storeId, {
      title: "Any",
      type: "smart",
      rules: { match: "any", conditions: [{ field: "vendor", relation: "equals", value: "weaver" }, { field: "title", relation: "contains", value: "tee" }] },
    });
    expect(any.productsCount).toBe(2);

    // Product edits re-evaluate membership.
    await updateProduct(deps, ACTOR, storeId, saree.id, { title: "Silk saree", status: "active", vendor: "Loom", productType: "Saree", tags: ["silk"], variants: [{ price: 500_000 }] });
    expect((await getProductAdmin(deps, storeId, saree.id)).collections).toEqual([]);
    expect((await getProductAdmin(deps, storeId, tee.id)).collections.map((c) => c.title).sort()).toEqual(["Any", "Cheap cotton"]);

    // Rule changes rebuild membership.
    const changed = await updateCollection(deps, ACTOR, storeId, all.id, { title: "Cheap cotton", type: "smart", rules: { match: "all", conditions: [{ field: "type", relation: "equals", value: "saree" }] } });
    expect(changed.products.map((p) => p.id)).toEqual([saree.id]);
    await expect(updateCollection(deps, ACTOR, storeId, all.id, { title: "x", type: "manual" })).rejects.toThrow(AppError);
  });

  it("manual collections keep their order", async () => {
    const ids: string[] = [];
    for (const t of ["A", "B", "C"]) ids.push((await createProduct(deps, ACTOR, storeId, { title: t, status: "active", variants: [{ price: 100 }] })).id);
    const c = await createCollection(deps, ACTOR, storeId, { title: "Picks", sortOrder: "manual", productIds: [ids[2]!, ids[0]!] });
    expect(c.products.map((p) => p.title)).toEqual(["C", "A"]);
    await addProductsToCollection(deps, ACTOR, storeId, c.id, [ids[1]!]);
    const listing = await listStorefrontProducts(deps, storeId, {}, { id: c.id, sortOrder: "manual" });
    expect(listing.items.map((p) => p.title)).toEqual(["C", "A", "B"]);
    await deleteProduct(deps, ACTOR, storeId, ids[0]!);
    expect((await getStorefrontCollection(deps, storeId, "picks"))!.productsCount).toBe(2);
  });
});

describe("storefront", () => {
  it("shows only active products, without cost, with option/price/availability filters", async () => {
    const location = await ensureDefaultLocation(deps.db, storeId);
    const input = teeInput();
    input.variants = input.variants.map((v) => ({ ...v, cost: 100, inventory: [{ locationId: location, available: v.options![1] === "Red" ? 3 : 0 }] }));
    await createProduct(deps, ACTOR, storeId, input);
    await createProduct(deps, ACTOR, storeId, { title: "Draft", variants: [{ price: 1 }] });
    await createProduct(deps, ACTOR, storeId, { title: "Mug", status: "active", options: [{ name: "Colour", values: ["White"] }], variants: [{ options: ["White"], price: 40_000, tracked: false }] });

    const p = await getStorefrontProduct(deps, storeId, "block-print-tee");
    expect(p).not.toBeNull();
    expect(JSON.stringify(p)).not.toContain('"cost"');
    expect(p!.variants.find((v) => v.title === "S / Red")!.available).toBe(true);
    expect(p!.variants.find((v) => v.title === "S / Blue")!.available).toBe(false);
    expect(await getStorefrontProduct(deps, storeId, "draft")).toBeNull();

    const titles = async (q: Parameters<typeof listStorefrontProducts>[2]) => (await listStorefrontProducts(deps, storeId, q)).items.map((x) => x.title).sort();
    expect(await titles({})).toEqual(["Block Print Tee", "Mug"]);
    expect(await titles({ option: ["colour:white"] })).toEqual(["Mug"]);
    expect(await titles({ option: ["Colour:Blue", "Colour:White"] })).toEqual(["Block Print Tee", "Mug"]);
    expect(await titles({ option: ["Colour:Blue", "Size:XL"] })).toEqual([]);
    expect(await titles({ priceMin: 100_000 })).toEqual(["Block Print Tee"]);
    expect(await titles({ priceMax: 50_000 })).toEqual(["Mug"]);
    expect(await titles({ tag: "cotton" })).toEqual(["Block Print Tee"]);
    expect(await titles({ available: "true" })).toEqual(["Block Print Tee", "Mug"]);

    const facets = await storefrontFacets(deps, storeId);
    expect(facets.options).toEqual(expect.arrayContaining([{ name: "Colour", values: expect.arrayContaining([{ value: "Red", count: 1 }, { value: "White", count: 1 }]) }]));
    expect(facets.price).toEqual({ min: 40_000, max: 119_900 });
  });

  it("paginates by cursor without gaps or repeats", async () => {
    for (let i = 0; i < 25; i++) await createProduct(deps, ACTOR, storeId, { title: `Item ${String(i).padStart(2, "0")}`, status: "active", variants: [{ price: (i % 5) * 100 }] });
    for (const sort of ["price_asc", "title_desc", "created_desc"] as const) {
      const seen: string[] = [];
      let cursor: string | undefined;
      do {
        const pageRes = await listStorefrontProducts(deps, storeId, { sort, limit: 7, ...(cursor ? { cursor } : {}) });
        seen.push(...pageRes.items.map((x) => x.id));
        cursor = pageRes.nextCursor ?? undefined;
      } while (cursor);
      expect(new Set(seen).size).toBe(25);
    }
  });

  it("searches active products with Postgres full-text and trigram", async () => {
    await createProduct(deps, ACTOR, storeId, teeInput());
    await createProduct(deps, ACTOR, storeId, { title: "Chanderi dupatta", status: "active", tags: ["festive"], variants: [{ price: 1 }] });
    await createProduct(deps, ACTOR, storeId, { title: "Hidden tee", status: "draft", variants: [{ price: 1 }] });
    expect((await searchStorefront(deps, storeId, "tee", { limit: 10 })).items.map((p) => p.title)).toEqual(["Block Print Tee"]);
    expect((await searchStorefront(deps, storeId, "festive", { limit: 10 })).items.map((p) => p.title)).toEqual(["Chanderi dupatta"]);
    expect((await searchStorefront(deps, storeId, "chanderri dupata", { limit: 10 })).items).toHaveLength(1);
    expect((await postgresSearch(deps.db).search(storeId, "TEE-M-Red", { limit: 5, offset: 0 })).total).toBe(1);
    expect((await searchStorefront(deps, storeId, "!!!", { limit: 10 })).items).toEqual([]);
  });
});

describe("refresh", () => {
  it("keeps denormalised columns consistent", async () => {
    const p = await createProduct(deps, ACTOR, storeId, teeInput());
    const { rows } = await deps.db.execute<{ ok: boolean }>(sql`
      select (p.price_min = (select min(price) from product_variants where product_id = p.id)) as ok
      from products p where p.id = ${p.id}`);
    expect(rows[0]!.ok).toBe(true);
    expect(await deps.db.$count(media)).toBe(0);
  });
});
