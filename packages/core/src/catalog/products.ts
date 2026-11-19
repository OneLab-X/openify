import {
  and,
  asc,
  collectionProducts,
  collections,
  eq,
  inArray,
  media,
  productMedia,
  productOptions,
  productOptionValues,
  productTags,
  productTypes,
  products,
  productVariants,
  savedViews,
  sql,
  tags,
  vendors,
  type Executor,
  type InventoryReason,
} from "@shopkit/db";
import { z } from "zod";
import { writeAudit } from "../audit.js";
import type { Actor, CoreDeps } from "../deps.js";
import { AppError, notFound } from "../errors.js";
import { enqueueEvent } from "../outbox.js";
import { getStore } from "../stores.js";
import { afterCursor, orderBy, page, type SortSpec } from "./cursor.js";
import { HANDLE_RE, slugify, uniqueHandle } from "./handles.js";
import { sanitizeHtml } from "./html.js";
import { applyInventoryChanges, ensureInventoryItem, levelsForVariants, type QuantityChange } from "./inventory.js";
import { mediaByIds, mediaView } from "./media-view.js";
import { metafieldInput, metafieldsFor, replaceMetafields } from "./metafields.js";
import { refreshProducts, updateCollectionCount } from "./refresh.js";
import { productTextMatch } from "./text-search.js";

// ── Input ────────────────────────────────────────────────────────────────────
const money = z.number().int().min(0).max(10_000_000_000_000);
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v ? v : null));

export const variantInput = z.object({
  id: z.uuid().optional(),
  /** Values in the order of the product's options ([] for a product without options). */
  options: z.array(z.string().trim().min(1).max(255)).max(3).default([]),
  price: money,
  compareAtPrice: money.nullish(),
  cost: money.nullish(),
  sku: optionalText(255),
  barcode: optionalText(255),
  weight: z.number().min(0).max(1_000_000).nullish(),
  weightUnit: z.enum(["kg", "g", "lb", "oz"]).optional(),
  requiresShipping: z.boolean().default(true),
  taxable: z.boolean().default(true),
  hsnCode: z
    .string()
    .trim()
    .regex(/^\d{4,8}$/, "HSN/SAC codes are 4–8 digits")
    .nullish()
    .or(z.literal("").transform(() => null)),
  inventoryPolicy: z.enum(["deny", "continue"]).default("deny"),
  /** "Track quantity". */
  tracked: z.boolean().default(true),
  imageMediaId: z.uuid().nullish(),
  /** Absolute "available" quantities to set per location (omitted = unchanged). */
  inventory: z.array(z.object({ locationId: z.uuid(), available: z.number().int().min(-1_000_000).max(1_000_000_000) })).optional(),
});
export type VariantInput = z.input<typeof variantInput>;

export const productInput = z.object({
  title: z.string().trim().min(1, "Title is required").max(255),
  handle: z.string().trim().max(255).optional(),
  descriptionHtml: z.string().max(512_000).default(""),
  status: z.enum(["draft", "active", "archived"]).default("draft"),
  vendor: optionalText(255),
  productType: optionalText(255),
  tags: z.array(z.string().trim().min(1).max(255)).max(250).default([]),
  seoTitle: optionalText(255),
  seoDescription: optionalText(1000),
  options: z
    .array(z.object({ name: z.string().trim().min(1).max(255), values: z.array(z.string().trim().min(1).max(255)).min(1).max(250) }))
    .max(3, "Up to 3 options")
    .default([]),
  variants: z.array(variantInput).min(1, "Add at least one variant").max(2048),
  /** Ordered product images (uploaded first through the media endpoints). */
  mediaIds: z.array(z.uuid()).max(250).default([]),
  /** Omitted = keep existing metafields. */
  metafields: z.array(metafieldInput).max(200).optional(),
});
export type ProductInput = z.input<typeof productInput>;
type ParsedProduct = z.output<typeof productInput>;

const issue = (path: string, message: string) => new AppError("validation_failed", "Check the highlighted fields", [{ path, message }]);
const optionKey = (values: (string | null | undefined)[]) => JSON.stringify(values.map((v) => (v ?? "").toLowerCase()));

/** Options and variants must agree: every variant picks one value per option, combinations unique. */
function validateOptions(data: ParsedProduct) {
  const names = new Set<string>();
  data.options.forEach((o, i) => {
    if (names.has(o.name.toLowerCase())) throw issue(`options.${i}.name`, "Option names must be different");
    names.add(o.name.toLowerCase());
    const values = new Set<string>();
    o.values.forEach((v, j) => {
      if (values.has(v.toLowerCase())) throw issue(`options.${i}.values.${j}`, `"${v}" is listed twice`);
      values.add(v.toLowerCase());
    });
  });
  if (data.options.length === 0 && data.variants.length > 1) throw issue("variants", "Add options to create more than one variant");
  const combos = new Set<string>();
  data.variants.forEach((v, i) => {
    if (v.options.length !== data.options.length) throw issue(`variants.${i}.options`, `Choose a value for each of the ${data.options.length} options`);
    v.options.forEach((value, j) => {
      if (!data.options[j]!.values.some((x) => x.toLowerCase() === value.toLowerCase())) {
        throw issue(`variants.${i}.options.${j}`, `"${value}" is not a value of ${data.options[j]!.name}`);
      }
    });
    const key = optionKey(v.options);
    if (combos.has(key)) throw issue(`variants.${i}.options`, `Two variants are ${v.options.join(" / ")}`);
    combos.add(key);
    if (v.imageMediaId && !data.mediaIds.includes(v.imageMediaId)) throw issue(`variants.${i}.imageMediaId`, "Variant image must be one of the product's images");
  });
}

export interface SaveOptions {
  /** Ledger reason for quantities set through the product (admin editor: correction, CSV: import). */
  inventoryReason?: InventoryReason;
  /** Skip the outbox event (bulk callers emit their own). */
  quiet?: boolean;
}

async function upsertNames(tx: Executor, table: typeof vendors | typeof productTypes, storeId: string, name: string | null) {
  if (name) await tx.insert(table).values({ storeId, name }).onConflictDoNothing();
}

async function upsertTags(tx: Executor, storeId: string, names: string[]): Promise<string[]> {
  const unique = [...new Map(names.map((n) => [n.toLowerCase(), n])).values()];
  if (unique.length === 0) return [];
  await tx.insert(tags).values(unique.map((name) => ({ storeId, name }))).onConflictDoNothing();
  const rows = await tx.select({ id: tags.id }).from(tags).where(and(eq(tags.storeId, storeId), inArray(tags.name, unique)));
  return rows.map((r) => r.id);
}

/**
 * Creates or fully replaces a product (options, variants, tags, media, metafields, inventory) in the
 * caller's transaction. Variants keep their id (and inventory) when matched by id or by options.
 */
export async function saveProduct(
  tx: Executor,
  actor: Actor,
  storeId: string,
  existingId: string | null,
  input: ProductInput,
  opts: SaveOptions = {},
): Promise<{ id: string; created: boolean; handle: string; previousHandle: string | null }> {
  const data = productInput.parse(input);
  validateOptions(data);
  const store = await getStore(tx, storeId);
  const currency = store.currency ?? "USD";

  const [existing] = existingId
    ? await tx.select().from(products).where(and(eq(products.storeId, storeId), eq(products.id, existingId))).for("update")
    : [];
  if (existingId && !existing) throw notFound("Product");

  let handle: string;
  if (data.handle) {
    handle = slugify(data.handle);
    if (!HANDLE_RE.test(handle)) throw issue("handle", "Use letters, numbers and hyphens");
    const [clash] = await tx
      .select({ id: products.id })
      .from(products)
      .where(and(eq(products.storeId, storeId), eq(products.handle, handle)));
    if (clash && clash.id !== existingId) throw issue("handle", "Another product already uses this handle");
  } else {
    handle = existing?.handle ?? (await uniqueHandle(tx, products, storeId, slugify(data.title), existingId ?? undefined));
  }

  if (data.mediaIds.length) {
    const owned = await tx.select({ id: media.id }).from(media).where(and(eq(media.storeId, storeId), inArray(media.id, data.mediaIds)));
    if (owned.length !== new Set(data.mediaIds).size) throw issue("mediaIds", "Unknown image");
  }

  const now = new Date();
  const values = {
    title: data.title,
    handle,
    descriptionHtml: await sanitizeHtml(data.descriptionHtml),
    status: data.status,
    vendor: data.vendor,
    productType: data.productType,
    seoTitle: data.seoTitle,
    seoDescription: data.seoDescription,
    currency,
    featuredMediaId: data.mediaIds[0] ?? null,
    publishedAt: data.status === "active" ? (existing?.publishedAt ?? now) : (existing?.publishedAt ?? null),
    archivedAt: data.status === "archived" ? (existing?.archivedAt ?? now) : null,
  };
  let id: string;
  if (existing) {
    await tx.update(products).set({ ...values, updatedAt: now }).where(eq(products.id, existing.id));
    id = existing.id;
  } else {
    const [row] = await tx.insert(products).values({ storeId, ...values }).returning({ id: products.id });
    id = row!.id;
  }

  // Options: replaced wholesale (variants carry the values as text, Shopify-style).
  await tx.delete(productOptions).where(eq(productOptions.productId, id));
  for (const [i, o] of data.options.entries()) {
    const [opt] = await tx.insert(productOptions).values({ storeId, productId: id, name: o.name, position: i + 1 }).returning({ id: productOptions.id });
    await tx.insert(productOptionValues).values(o.values.map((value, j) => ({ storeId, optionId: opt!.id, value, position: j + 1 })));
  }

  // Variants: match by id, then by option combination; delete the rest.
  const current = existing ? await tx.select().from(productVariants).where(eq(productVariants.productId, id)) : [];
  const byId = new Map(current.map((v) => [v.id, v]));
  const byOptions = new Map(current.map((v) => [optionKey([v.option1, v.option2, v.option3].slice(0, Math.max(data.options.length, 0))), v]));
  const keep = new Set<string>();
  // Park retained rows on temporary option values so re-ordered combinations never collide.
  const matched = data.variants.map((v) => {
    const hit = (v.id && byId.get(v.id)) || byOptions.get(optionKey(v.options));
    if (hit && !keep.has(hit.id)) {
      keep.add(hit.id);
      return hit.id;
    }
    return null;
  });
  const stale = current.filter((v) => !keep.has(v.id)).map((v) => v.id);
  if (stale.length) await tx.delete(productVariants).where(inArray(productVariants.id, stale));
  if (keep.size) {
    await tx
      .update(productVariants)
      .set({ option1: sql`'__tmp_' || ${productVariants.id}::text`, option2: null, option3: null })
      .where(inArray(productVariants.id, [...keep]));
  }

  const changes: QuantityChange[] = [];
  for (const [i, v] of data.variants.entries()) {
    const row = {
      storeId,
      productId: id,
      title: v.options.length ? v.options.join(" / ") : "Default Title",
      position: i + 1,
      option1: v.options[0] ?? null,
      option2: v.options[1] ?? null,
      option3: v.options[2] ?? null,
      price: v.price,
      compareAtPrice: v.compareAtPrice ?? null,
      cost: v.cost ?? null,
      currency,
      sku: v.sku,
      barcode: v.barcode,
      weight: v.weight ?? null,
      weightUnit: v.weightUnit ?? store.weightUnit ?? "kg",
      requiresShipping: v.requiresShipping,
      taxable: v.taxable,
      hsnCode: v.hsnCode ?? null,
      inventoryPolicy: v.inventoryPolicy,
      imageMediaId: v.imageMediaId ?? null,
    };
    let variantId = matched[i];
    if (variantId) {
      await tx.update(productVariants).set({ ...row, updatedAt: now }).where(eq(productVariants.id, variantId));
    } else {
      const [created] = await tx.insert(productVariants).values(row).returning({ id: productVariants.id });
      variantId = created!.id;
    }
    const itemId = await ensureInventoryItem(tx, storeId, variantId, v.tracked);
    for (const q of v.inventory ?? []) changes.push({ inventoryItemId: itemId, locationId: q.locationId, quantity: "available", set: q.available });
  }
  await applyInventoryChanges(tx, actor, storeId, changes, opts.inventoryReason ?? "correction");

  // Tags, vendor/type lists, media order, metafields.
  const tagIds = await upsertTags(tx, storeId, data.tags);
  await tx.delete(productTags).where(eq(productTags.productId, id));
  if (tagIds.length) await tx.insert(productTags).values(tagIds.map((tagId) => ({ storeId, productId: id, tagId })));
  await upsertNames(tx, vendors, storeId, data.vendor);
  await upsertNames(tx, productTypes, storeId, data.productType);
  await tx.delete(productMedia).where(eq(productMedia.productId, id));
  const mediaIds = [...new Set(data.mediaIds)];
  if (mediaIds.length) await tx.insert(productMedia).values(mediaIds.map((mediaId, i) => ({ storeId, productId: id, mediaId, position: i + 1 })));
  if (data.metafields) await replaceMetafields(tx, storeId, "product", id, data.metafields);

  await refreshProducts(tx, storeId, [id]);
  const previousHandle = existing && existing.handle !== handle ? existing.handle : null;
  if (!opts.quiet) {
    await enqueueEvent(tx, { storeId, type: existing ? "product.updated" : "product.created", payload: { productId: id, handle, previousHandle } });
  }
  await writeAudit(tx, actor, { storeId, action: existing ? "product.updated" : "product.created", resourceType: "product", resourceId: id });
  return { id, created: !existing, handle, previousHandle };
}

export async function createProduct(deps: CoreDeps, actor: Actor, storeId: string, input: ProductInput) {
  const { id } = await deps.db.transaction((tx) => saveProduct(tx, actor, storeId, null, input));
  return getProductAdmin(deps, storeId, id);
}

export async function updateProduct(deps: CoreDeps, actor: Actor, storeId: string, id: string, input: ProductInput) {
  await deps.db.transaction((tx) => saveProduct(tx, actor, storeId, id, input));
  return getProductAdmin(deps, storeId, id);
}

// ── Admin view ───────────────────────────────────────────────────────────────
export async function getProductAdmin(deps: CoreDeps, storeId: string, id: string) {
  const db = deps.db;
  const [p] = await db.select().from(products).where(and(eq(products.storeId, storeId), eq(products.id, id)));
  if (!p) throw notFound("Product");
  const [opts, values, variants, tagRows, mediaRows, colls] = await Promise.all([
    db.select().from(productOptions).where(eq(productOptions.productId, id)).orderBy(asc(productOptions.position)),
    db
      .select({ optionId: productOptionValues.optionId, value: productOptionValues.value })
      .from(productOptionValues)
      .innerJoin(productOptions, eq(productOptions.id, productOptionValues.optionId))
      .where(eq(productOptions.productId, id))
      .orderBy(asc(productOptionValues.position)),
    db.select().from(productVariants).where(eq(productVariants.productId, id)).orderBy(asc(productVariants.position)),
    db.select({ name: tags.name }).from(productTags).innerJoin(tags, eq(tags.id, productTags.tagId)).where(eq(productTags.productId, id)).orderBy(asc(tags.name)),
    db.select().from(productMedia).innerJoin(media, eq(media.id, productMedia.mediaId)).where(eq(productMedia.productId, id)).orderBy(asc(productMedia.position)),
    db
      .select({ id: collections.id, title: collections.title, handle: collections.handle, type: collections.type })
      .from(collectionProducts)
      .innerJoin(collections, eq(collections.id, collectionProducts.collectionId))
      .where(eq(collectionProducts.productId, id))
      .orderBy(asc(collections.title)),
  ]);
  const [levels, metas] = await Promise.all([levelsForVariants(db, variants.map((v) => v.id)), metafieldsFor(db, "product", [id])]);
  return {
    id: p.id,
    title: p.title,
    handle: p.handle,
    descriptionHtml: await sanitizeHtml(p.descriptionHtml),
    status: p.status,
    vendor: p.vendor,
    productType: p.productType,
    tags: tagRows.map((t) => t.name),
    seoTitle: p.seoTitle,
    seoDescription: p.seoDescription,
    currency: p.currency,
    priceMin: p.priceMin,
    priceMax: p.priceMax,
    available: p.available,
    totalInventory: p.totalInventory,
    options: opts.map((o) => ({ id: o.id, name: o.name, position: o.position, values: values.filter((v) => v.optionId === o.id).map((v) => v.value) })),
    variants: variants.map((v) => {
      const inv = levels.get(v.id);
      return {
        id: v.id,
        title: v.title,
        position: v.position,
        options: [v.option1, v.option2, v.option3].filter((x): x is string => x !== null),
        price: v.price,
        compareAtPrice: v.compareAtPrice,
        cost: v.cost,
        currency: v.currency,
        sku: v.sku,
        barcode: v.barcode,
        weight: v.weight,
        weightUnit: v.weightUnit,
        requiresShipping: v.requiresShipping,
        taxable: v.taxable,
        hsnCode: v.hsnCode,
        inventoryPolicy: v.inventoryPolicy,
        imageMediaId: v.imageMediaId,
        inventoryItemId: inv?.inventoryItemId ?? null,
        tracked: inv?.tracked ?? true,
        inventory: inv?.levels ?? [],
      };
    }),
    media: mediaRows.map((r) => mediaView(deps, r.media)),
    metafields: metas.get(id) ?? [],
    collections: colls,
    publishedAt: p.publishedAt?.toISOString() ?? null,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}
export type ProductAdmin = Awaited<ReturnType<typeof getProductAdmin>>;

// ── Admin list ───────────────────────────────────────────────────────────────
export const PRODUCT_SORTS = ["updated_desc", "created_desc", "title_asc", "title_desc", "price_asc", "price_desc", "inventory_asc", "inventory_desc"] as const;

export const productListQuery = z.object({
  q: z.string().trim().max(200).optional(),
  status: z.enum(["draft", "active", "archived"]).optional(),
  vendor: z.string().trim().max(255).optional(),
  productType: z.string().trim().max(255).optional(),
  tag: z.string().trim().max(255).optional(),
  collectionId: z.uuid().optional(),
  availability: z.enum(["in_stock", "out_of_stock"]).optional(),
  sort: z.enum(PRODUCT_SORTS).default("updated_desc"),
  limit: z.coerce.number().int().min(1).max(250).default(50),
  cursor: z.string().max(500).optional(),
});
export type ProductListQuery = z.input<typeof productListQuery>;

type ListRow = typeof products.$inferSelect;
function productSort(sort: (typeof PRODUCT_SORTS)[number]): SortSpec<ListRow> {
  const id = sql`p.id`;
  const rowId = (r: ListRow) => r.id;
  switch (sort) {
    case "created_desc":
      return { dir: "desc", id, rowId, keys: [{ expr: sql`p.created_at`, cast: "timestamptz", value: (r) => r.createdAt.toISOString() }] };
    case "title_asc":
    case "title_desc":
      return { dir: sort === "title_asc" ? "asc" : "desc", id, rowId, keys: [{ expr: sql`lower(p.title)`, cast: "text", value: (r) => r.title.toLowerCase() }] };
    case "price_asc":
    case "price_desc":
      return { dir: sort === "price_asc" ? "asc" : "desc", id, rowId, keys: [{ expr: sql`p.price_min`, cast: "bigint", value: (r) => r.priceMin }] };
    case "inventory_asc":
    case "inventory_desc":
      return { dir: sort === "inventory_asc" ? "asc" : "desc", id, rowId, keys: [{ expr: sql`p.total_inventory`, cast: "int", value: (r) => r.totalInventory }] };
    default:
      return { dir: "desc", id, rowId, keys: [{ expr: sql`p.updated_at`, cast: "timestamptz", value: (r) => r.updatedAt.toISOString() }] };
  }
}

/** Filters shared by the admin list, bulk actions and CSV export. */
export function productFilter(storeId: string, q: Omit<z.output<typeof productListQuery>, "sort" | "limit" | "cursor">) {
  return sql.join(
    [
      sql`p.store_id = ${storeId}`,
      q.status ? sql`p.status = ${q.status}` : sql`true`,
      q.vendor ? sql`lower(p.vendor) = lower(${q.vendor})` : sql`true`,
      q.productType ? sql`lower(p.product_type) = lower(${q.productType})` : sql`true`,
      q.tag ? sql`exists (select 1 from product_tags pt join tags t on t.id = pt.tag_id where pt.product_id = p.id and t.name = ${q.tag})` : sql`true`,
      q.collectionId ? sql`exists (select 1 from collection_products cp where cp.product_id = p.id and cp.collection_id = ${q.collectionId})` : sql`true`,
      q.availability === "in_stock" ? sql`p.available` : q.availability === "out_of_stock" ? sql`not p.available` : sql`true`,
      q.q ? productTextMatch(q.q) : sql`true`,
    ],
    sql` and `,
  );
}

export async function listProductsAdmin(deps: CoreDeps, storeId: string, query: ProductListQuery) {
  const q = productListQuery.parse(query);
  const spec = productSort(q.sort);
  const { rows } = await deps.db.execute(sql`
    select p.* from products p
    where ${productFilter(storeId, q)} and ${afterCursor(spec, q.cursor)}
    order by ${orderBy(spec)}
    limit ${q.limit + 1}`);
  const list = rows.map(fromRaw);
  const result = page(spec, list, q.limit);
  const [mediaMap, variantCounts] = await Promise.all([
    mediaByIds(deps.db, result.items.map((p) => p.featuredMediaId ?? "")),
    result.items.length
      ? deps.db
          .select({ productId: productVariants.productId, n: sql<number>`count(*)::int` })
          .from(productVariants)
          .where(inArray(productVariants.productId, result.items.map((p) => p.id)))
          .groupBy(productVariants.productId)
      : Promise.resolve([]),
  ]);
  const counts = new Map(variantCounts.map((c) => [c.productId, c.n]));
  return {
    items: result.items.map((p) => {
      const m = p.featuredMediaId ? mediaMap.get(p.featuredMediaId) : undefined;
      return {
        id: p.id,
        title: p.title,
        handle: p.handle,
        status: p.status,
        vendor: p.vendor,
        productType: p.productType,
        priceMin: p.priceMin,
        priceMax: p.priceMax,
        currency: p.currency,
        available: p.available,
        totalInventory: p.totalInventory,
        variantsCount: counts.get(p.id) ?? 0,
        image: m ? mediaView(deps, m) : null,
        updatedAt: p.updatedAt.toISOString(),
      };
    }),
    nextCursor: result.nextCursor,
  };
}

/** Raw `select p.*` rows (snake_case) → the drizzle row shape. */
export function fromRaw(r: Record<string, unknown>): ListRow {
  return {
    id: r.id as string,
    storeId: r.store_id as string,
    title: r.title as string,
    handle: r.handle as string,
    descriptionHtml: r.description_html as string,
    status: r.status as ListRow["status"],
    vendor: r.vendor as string | null,
    productType: r.product_type as string | null,
    seoTitle: r.seo_title as string | null,
    seoDescription: r.seo_description as string | null,
    currency: r.currency as string,
    priceMin: Number(r.price_min),
    priceMax: Number(r.price_max),
    compareAtPriceMax: r.compare_at_price_max === null ? null : Number(r.compare_at_price_max),
    available: r.available as boolean,
    totalInventory: Number(r.total_inventory),
    featuredMediaId: r.featured_media_id as string | null,
    searchVector: null,
    publishedAt: r.published_at ? new Date(r.published_at as string) : null,
    archivedAt: r.archived_at ? new Date(r.archived_at as string) : null,
    createdAt: new Date(r.created_at as string),
    updatedAt: new Date(r.updated_at as string),
  };
}

// ── Bulk actions ─────────────────────────────────────────────────────────────
export const bulkProductInput = z.object({
  ids: z.array(z.uuid()).min(1).max(500),
  action: z.discriminatedUnion("type", [
    z.object({ type: z.literal("set_status"), status: z.enum(["draft", "active", "archived"]) }),
    z.object({ type: z.literal("add_tags"), tags: z.array(z.string().trim().min(1).max(255)).min(1).max(50) }),
    z.object({ type: z.literal("remove_tags"), tags: z.array(z.string().trim().min(1).max(255)).min(1).max(50) }),
    z.object({ type: z.literal("set_vendor"), vendor: optionalText(255) }),
    z.object({ type: z.literal("set_product_type"), productType: optionalText(255) }),
    z.object({ type: z.literal("delete") }),
  ]),
});
export type BulkProductInput = z.input<typeof bulkProductInput>;

/** Bulk edit/archive/tag/delete from the product list. One transaction, one event per product. */
export async function bulkUpdateProducts(deps: CoreDeps, actor: Actor, storeId: string, input: BulkProductInput): Promise<{ updated: number }> {
  const { ids, action } = bulkProductInput.parse(input);
  return deps.db.transaction(async (tx) => {
    const rows = await tx
      .select({ id: products.id, handle: products.handle, publishedAt: products.publishedAt })
      .from(products)
      .where(and(eq(products.storeId, storeId), inArray(products.id, ids)))
      .for("update");
    const found = rows.map((r) => r.id);
    if (found.length === 0) return { updated: 0 };
    const now = new Date();
    switch (action.type) {
      case "delete":
        await deleteProductsTx(tx, actor, storeId, found);
        return { updated: found.length };
      case "set_status":
        await tx
          .update(products)
          .set({
            status: action.status,
            updatedAt: now,
            archivedAt: action.status === "archived" ? now : null,
            ...(action.status === "active" ? { publishedAt: sql`coalesce(${products.publishedAt}, now())` } : {}),
          })
          .where(inArray(products.id, found));
        break;
      case "add_tags": {
        const tagIds = await upsertTags(tx, storeId, action.tags);
        await tx
          .insert(productTags)
          .values(found.flatMap((productId) => tagIds.map((tagId) => ({ storeId, productId, tagId }))))
          .onConflictDoNothing();
        await tx.update(products).set({ updatedAt: now }).where(inArray(products.id, found));
        break;
      }
      case "remove_tags": {
        const tagRows = await tx.select({ id: tags.id }).from(tags).where(and(eq(tags.storeId, storeId), inArray(tags.name, action.tags)));
        if (tagRows.length) {
          await tx.delete(productTags).where(and(inArray(productTags.productId, found), inArray(productTags.tagId, tagRows.map((t) => t.id))));
        }
        await tx.update(products).set({ updatedAt: now }).where(inArray(products.id, found));
        break;
      }
      case "set_vendor":
        await upsertNames(tx, vendors, storeId, action.vendor);
        await tx.update(products).set({ vendor: action.vendor, updatedAt: now }).where(inArray(products.id, found));
        break;
      case "set_product_type":
        await upsertNames(tx, productTypes, storeId, action.productType);
        await tx.update(products).set({ productType: action.productType, updatedAt: now }).where(inArray(products.id, found));
        break;
    }
    await refreshProducts(tx, storeId, found);
    for (const r of rows) await enqueueEvent(tx, { storeId, type: "product.updated", payload: { productId: r.id, handle: r.handle } });
    await writeAudit(tx, actor, { storeId, action: `product.bulk_${action.type}`, resourceType: "product", metadata: { count: found.length } });
    return { updated: found.length };
  });
}

async function deleteProductsTx(tx: Executor, actor: Actor, storeId: string, ids: string[]) {
  const rows = await tx.select({ id: products.id, handle: products.handle }).from(products).where(and(eq(products.storeId, storeId), inArray(products.id, ids)));
  if (rows.length === 0) return;
  const affected = await tx
    .selectDistinct({ id: collectionProducts.collectionId })
    .from(collectionProducts)
    .where(inArray(collectionProducts.productId, rows.map((r) => r.id)));
  await tx.delete(products).where(inArray(products.id, rows.map((r) => r.id)));
  for (const c of affected) await updateCollectionCount(tx, c.id);
  for (const r of rows) {
    await enqueueEvent(tx, { storeId, type: "product.deleted", payload: { productId: r.id, handle: r.handle } });
    await writeAudit(tx, actor, { storeId, action: "product.deleted", resourceType: "product", resourceId: r.id });
  }
}

export async function deleteProduct(deps: CoreDeps, actor: Actor, storeId: string, id: string) {
  await deps.db.transaction(async (tx) => {
    const [row] = await tx.select({ id: products.id }).from(products).where(and(eq(products.storeId, storeId), eq(products.id, id)));
    if (!row) throw notFound("Product");
    await deleteProductsTx(tx, actor, storeId, [id]);
  });
}

// ── Inventory adjustments (admin inventory page) ────────────────────────────
export async function adjustInventory(
  deps: CoreDeps,
  actor: Actor,
  storeId: string,
  input: { reason: InventoryReason; note?: string | undefined; changes: QuantityChange[] },
) {
  return deps.db.transaction(async (tx) => {
    const productIds = await applyInventoryChanges(tx, actor, storeId, input.changes, input.reason, input.note);
    await refreshProducts(tx, storeId, productIds);
    if (productIds.length) {
      const rows = await tx.select({ id: products.id, handle: products.handle }).from(products).where(inArray(products.id, productIds));
      for (const r of rows) await enqueueEvent(tx, { storeId, type: "product.updated", payload: { productId: r.id, handle: r.handle, reason: "inventory" } });
    }
    return { productIds };
  });
}

// ── Lookups for admin pickers and filters ───────────────────────────────────
export async function catalogFacets(db: Executor, storeId: string) {
  const [v, t, g] = await Promise.all([
    db.select({ name: vendors.name }).from(vendors).where(eq(vendors.storeId, storeId)).orderBy(asc(vendors.name)),
    db.select({ name: productTypes.name }).from(productTypes).where(eq(productTypes.storeId, storeId)).orderBy(asc(productTypes.name)),
    db.select({ name: tags.name }).from(tags).where(eq(tags.storeId, storeId)).orderBy(asc(tags.name)).limit(1000),
  ]);
  return { vendors: v.map((r) => r.name), productTypes: t.map((r) => r.name), tags: g.map((r) => r.name) };
}

// ── Saved views ──────────────────────────────────────────────────────────────
export const savedViewInput = z.object({
  name: z.string().trim().min(1).max(80),
  filters: productListQuery.omit({ cursor: true, limit: true }).partial(),
});

export async function listSavedViews(db: Executor, storeId: string) {
  return db.select().from(savedViews).where(and(eq(savedViews.storeId, storeId), eq(savedViews.resource, "products"))).orderBy(asc(savedViews.name));
}

export async function createSavedView(db: Executor, actor: Actor, storeId: string, input: z.input<typeof savedViewInput>) {
  const data = savedViewInput.parse(input);
  const [row] = await db
    .insert(savedViews)
    .values({ storeId, resource: "products", name: data.name, filters: data.filters, createdBy: actor.id ?? null })
    .onConflictDoUpdate({ target: [savedViews.storeId, savedViews.resource, savedViews.name], set: { filters: data.filters } })
    .returning();
  return row!;
}

export async function deleteSavedView(db: Executor, storeId: string, id: string) {
  await db.delete(savedViews).where(and(eq(savedViews.storeId, storeId), eq(savedViews.id, id)));
}
