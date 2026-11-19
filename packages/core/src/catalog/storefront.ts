import { and, asc, collections, eq, inArray, media, productMedia, productOptions, productOptionValues, products, productTags, productVariants, sql, tags, type SQL } from "@shopkit/db";
import { z } from "zod";
import type { CoreDeps } from "../deps.js";
import { afterCursor, decodeCursor, encodeCursor, orderBy, page, type SortSpec } from "./cursor.js";
import { sanitizeHtml } from "./html.js";
import { levelsForVariants } from "./inventory.js";
import { mediaByIds, mediaView } from "./media-view.js";
import { fromRaw } from "./products.js";
import { searchEngine } from "./search.js";

/**
 * Public read models for the Storefront API (SPEC §9). Only active products and published
 * collections are visible; cost, inventory counts and metafields stay private.
 */
export const STOREFRONT_SORTS = ["manual", "best_selling", "title_asc", "title_desc", "price_asc", "price_desc", "created_desc", "created_asc"] as const;
type StorefrontSort = (typeof STOREFRONT_SORTS)[number];

const csv = z
  .union([z.string(), z.array(z.string())])
  .transform((v) => (Array.isArray(v) ? v : v.split(",")).map((s) => s.trim()).filter(Boolean))
  .optional();

export const storefrontListQuery = z.object({
  sort: z.enum(STOREFRONT_SORTS).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(24),
  cursor: z.string().max(500).optional(),
  /** Minor units, inclusive. */
  priceMin: z.coerce.number().int().min(0).optional(),
  priceMax: z.coerce.number().int().min(0).optional(),
  available: z.enum(["true", "false"]).transform((v) => v === "true").optional(),
  tag: csv,
  vendor: csv,
  productType: csv,
  /** Option filters as "Name:Value" pairs, e.g. option=Size:M&option=Colour:Red. */
  option: csv,
});
export type StorefrontListQuery = z.input<typeof storefrontListQuery>;

type Row = typeof products.$inferSelect & { position?: number };

function sortSpec(sort: StorefrontSort, inCollection: boolean): SortSpec<Row> {
  const id = sql`p.id`;
  const rowId = (r: Row) => r.id;
  switch (sort) {
    case "manual":
      if (inCollection) return { dir: "asc", id, rowId, keys: [{ expr: sql`cp.position`, cast: "int", value: (r) => r.position ?? 0 }] };
      return sortSpec("created_desc", inCollection);
    case "title_asc":
    case "title_desc":
      return { dir: sort === "title_asc" ? "asc" : "desc", id, rowId, keys: [{ expr: sql`lower(p.title)`, cast: "text", value: (r) => r.title.toLowerCase() }] };
    case "price_asc":
    case "price_desc":
      return { dir: sort === "price_asc" ? "asc" : "desc", id, rowId, keys: [{ expr: sql`p.price_min`, cast: "bigint", value: (r) => r.priceMin }] };
    case "created_asc":
      return { dir: "asc", id, rowId, keys: [{ expr: sql`p.created_at`, cast: "timestamptz", value: (r) => r.createdAt.toISOString() }] };
    // best_selling needs order data (Phase 3); newest first until then.
    default:
      return { dir: "desc", id, rowId, keys: [{ expr: sql`p.created_at`, cast: "timestamptz", value: (r) => r.createdAt.toISOString() }] };
  }
}

function filters(q: z.output<typeof storefrontListQuery>): SQL {
  const parts: SQL[] = [];
  if (q.priceMin !== undefined) parts.push(sql`exists (select 1 from product_variants v where v.product_id = p.id and v.price >= ${q.priceMin})`);
  if (q.priceMax !== undefined) parts.push(sql`exists (select 1 from product_variants v where v.product_id = p.id and v.price <= ${q.priceMax})`);
  if (q.available !== undefined) parts.push(q.available ? sql`p.available` : sql`not p.available`);
  if (q.tag?.length) {
    parts.push(sql`exists (select 1 from product_tags pt join tags t on t.id = pt.tag_id where pt.product_id = p.id and t.name in (${sql.join(q.tag.map((t) => sql`${t}`), sql`, `)}))`);
  }
  if (q.vendor?.length) parts.push(sql`lower(p.vendor) in (${sql.join(q.vendor.map((v) => sql`lower(${v})`), sql`, `)})`);
  if (q.productType?.length) parts.push(sql`lower(p.product_type) in (${sql.join(q.productType.map((v) => sql`lower(${v})`), sql`, `)})`);
  // Values of the same option are OR-ed; different options are AND-ed (Shopify filter semantics).
  const byOption = new Map<string, string[]>();
  for (const pair of q.option ?? []) {
    const idx = pair.indexOf(":");
    if (idx <= 0) continue;
    const name = pair.slice(0, idx).trim().toLowerCase();
    byOption.set(name, [...(byOption.get(name) ?? []), pair.slice(idx + 1).trim().toLowerCase()]);
  }
  for (const [name, values] of byOption) {
    parts.push(sql`exists (
      select 1 from product_options o join product_variants v on v.product_id = o.product_id
      where o.product_id = p.id and lower(o.name) = ${name}
        and lower(case o.position when 1 then v.option1 when 2 then v.option2 else v.option3 end) in (${sql.join(values.map((v) => sql`${v}`), sql`, `)}))`);
  }
  return parts.length ? sql.join(parts, sql` and `) : sql`true`;
}

export interface ProductCard {
  id: string;
  handle: string;
  title: string;
  vendor: string | null;
  productType: string | null;
  priceMin: number;
  priceMax: number;
  compareAtPriceMax: number | null;
  currency: string;
  available: boolean;
  image: ReturnType<typeof mediaView> | null;
}

async function cards(deps: CoreDeps, rows: Row[]): Promise<ProductCard[]> {
  const mediaMap = await mediaByIds(deps.db, rows.map((r) => r.featuredMediaId ?? ""));
  return rows.map((p) => {
    const m = p.featuredMediaId ? mediaMap.get(p.featuredMediaId) : undefined;
    return {
      id: p.id,
      handle: p.handle,
      title: p.title,
      vendor: p.vendor,
      productType: p.productType,
      priceMin: p.priceMin,
      priceMax: p.priceMax,
      compareAtPriceMax: p.compareAtPriceMax,
      currency: p.currency,
      available: p.available,
      image: m ? mediaView(deps, m) : null,
    };
  });
}

/** Lists active products, optionally inside a collection, with filters and cursor pagination. */
export async function listStorefrontProducts(deps: CoreDeps, storeId: string, query: StorefrontListQuery, collection?: { id: string; sortOrder: StorefrontSort }) {
  const q = storefrontListQuery.parse(query);
  const spec = sortSpec(q.sort ?? collection?.sortOrder ?? "created_desc", !!collection);
  const { rows } = await deps.db.execute(sql`
    select p.*${collection ? sql`, cp.position` : sql``} from products p
    ${collection ? sql`join collection_products cp on cp.product_id = p.id and cp.collection_id = ${collection.id}` : sql``}
    where p.store_id = ${storeId} and p.status = 'active' and ${filters(q)} and ${afterCursor(spec, q.cursor)}
    order by ${orderBy(spec)}
    limit ${q.limit + 1}`);
  const list: Row[] = rows.map((r) => ({ ...fromRaw(r), ...(collection ? { position: Number(r.position) } : {}) }));
  const result = page(spec, list, q.limit);
  return { items: await cards(deps, result.items), nextCursor: result.nextCursor };
}

/** Facet values for a listing (collection or all products), computed over active products. */
export async function storefrontFacets(deps: CoreDeps, storeId: string, collectionId?: string) {
  const scope = collectionId ? sql`and exists (select 1 from collection_products cp where cp.product_id = p.id and cp.collection_id = ${collectionId})` : sql``;
  const base = sql`from products p where p.store_id = ${storeId} and p.status = 'active' ${scope}`;
  const [price, optionRows, vendorRows, tagCounts] = await Promise.all([
    deps.db.execute<{ min: string | null; max: string | null }>(sql`select min(p.price_min) as min, max(p.price_max) as max ${base}`),
    deps.db.execute<{ name: string; value: string; n: number }>(sql`
      select o.name, v.value, count(distinct p.id)::int as n
      from products p
      join product_options o on o.product_id = p.id
      join product_option_values v on v.option_id = o.id
      where p.store_id = ${storeId} and p.status = 'active' ${scope}
      group by o.name, v.value, o.position, v.position
      order by o.position, o.name, v.position`),
    deps.db.execute<{ vendor: string; n: number }>(sql`select p.vendor as vendor, count(*)::int as n ${base} and p.vendor is not null group by p.vendor order by p.vendor`),
    deps.db.execute<{ name: string; n: number }>(sql`
      select t.name, count(*)::int as n
      from products p join product_tags pt on pt.product_id = p.id join tags t on t.id = pt.tag_id
      where p.store_id = ${storeId} and p.status = 'active' ${scope}
      group by t.name order by t.name limit 200`),
  ]);
  const options = new Map<string, { value: string; count: number }[]>();
  for (const r of optionRows.rows) {
    const list = options.get(r.name) ?? [];
    if (!list.some((x) => x.value.toLowerCase() === r.value.toLowerCase())) list.push({ value: r.value, count: r.n });
    options.set(r.name, list);
  }
  return {
    price: { min: Number(price.rows[0]?.min ?? 0), max: Number(price.rows[0]?.max ?? 0) },
    tags: tagCounts.rows.map((r) => ({ value: r.name, count: r.n })),
    vendors: vendorRows.rows.map((r) => ({ value: r.vendor, count: r.n })),
    options: [...options].map(([name, values]) => ({ name, values })),
  };
}

export async function getStorefrontProduct(deps: CoreDeps, storeId: string, handle: string) {
  const [p] = await deps.db
    .select()
    .from(products)
    .where(and(eq(products.storeId, storeId), eq(products.handle, handle), eq(products.status, "active")));
  if (!p) return null;
  const [opts, values, variants, tagRows, mediaRows] = await Promise.all([
    deps.db.select().from(productOptions).where(eq(productOptions.productId, p.id)).orderBy(asc(productOptions.position)),
    deps.db
      .select({ optionId: productOptionValues.optionId, value: productOptionValues.value })
      .from(productOptionValues)
      .innerJoin(productOptions, eq(productOptions.id, productOptionValues.optionId))
      .where(eq(productOptions.productId, p.id))
      .orderBy(asc(productOptionValues.position)),
    deps.db.select().from(productVariants).where(eq(productVariants.productId, p.id)).orderBy(asc(productVariants.position)),
    deps.db.select({ name: tags.name }).from(productTags).innerJoin(tags, eq(tags.id, productTags.tagId)).where(eq(productTags.productId, p.id)).orderBy(asc(tags.name)),
    deps.db.select().from(productMedia).innerJoin(media, eq(media.id, productMedia.mediaId)).where(eq(productMedia.productId, p.id)).orderBy(asc(productMedia.position)),
  ]);
  const levels = await levelsForVariants(deps.db, variants.map((v) => v.id));
  return {
    id: p.id,
    handle: p.handle,
    title: p.title,
    descriptionHtml: await sanitizeHtml(p.descriptionHtml),
    vendor: p.vendor,
    productType: p.productType,
    tags: tagRows.map((t) => t.name),
    seo: { title: p.seoTitle ?? p.title, description: p.seoDescription },
    currency: p.currency,
    priceMin: p.priceMin,
    priceMax: p.priceMax,
    compareAtPriceMax: p.compareAtPriceMax,
    available: p.available,
    options: opts.map((o) => ({ name: o.name, values: values.filter((v) => v.optionId === o.id).map((v) => v.value) })),
    variants: variants.map((v) => {
      const inv = levels.get(v.id);
      const stock = inv?.levels.reduce((n, l) => n + l.available, 0) ?? 0;
      return {
        id: v.id,
        title: v.title,
        options: [v.option1, v.option2, v.option3].filter((x): x is string => x !== null),
        price: v.price,
        compareAtPrice: v.compareAtPrice,
        currency: v.currency,
        sku: v.sku,
        available: !inv || !inv.tracked || v.inventoryPolicy === "continue" || stock > 0,
        imageId: v.imageMediaId,
        requiresShipping: v.requiresShipping,
      };
    }),
    images: mediaRows.map((r) => mediaView(deps, r.media)),
    publishedAt: p.publishedAt?.toISOString() ?? null,
    updatedAt: p.updatedAt.toISOString(),
  };
}

export async function getStorefrontCollection(deps: CoreDeps, storeId: string, handle: string) {
  const [c] = await deps.db
    .select()
    .from(collections)
    .where(and(eq(collections.storeId, storeId), eq(collections.handle, handle), eq(collections.published, true)));
  if (!c) return null;
  const image = c.imageMediaId ? (await mediaByIds(deps.db, [c.imageMediaId])).get(c.imageMediaId) : undefined;
  return {
    id: c.id,
    handle: c.handle,
    title: c.title,
    descriptionHtml: await sanitizeHtml(c.descriptionHtml),
    sortOrder: c.sortOrder,
    image: image ? mediaView(deps, image) : null,
    seo: { title: c.seoTitle ?? c.title, description: c.seoDescription },
    productsCount: c.productsCount,
    updatedAt: c.updatedAt.toISOString(),
  };
}

export async function listStorefrontCollections(deps: CoreDeps, storeId: string, opts: { limit: number; cursor?: string | undefined }) {
  const after = decodeCursor(opts.cursor, 2);
  const rows = await deps.db
    .select()
    .from(collections)
    .where(
      and(
        eq(collections.storeId, storeId),
        eq(collections.published, true),
        after ? sql`(lower(${collections.title}), ${collections.id}) > (${after[0] as string}, ${after[1] as string}::uuid)` : undefined,
      ),
    )
    .orderBy(sql`lower(${collections.title})`, asc(collections.id))
    .limit(opts.limit + 1);
  const items = rows.slice(0, opts.limit);
  const mediaMap = await mediaByIds(deps.db, items.map((c) => c.imageMediaId ?? ""));
  const last = items.at(-1);
  return {
    items: items.map((c) => {
      const m = c.imageMediaId ? mediaMap.get(c.imageMediaId) : undefined;
      return { id: c.id, handle: c.handle, title: c.title, productsCount: c.productsCount, image: m ? mediaView(deps, m) : null };
    }),
    nextCursor: rows.length > opts.limit && last ? encodeCursor([last.title.toLowerCase(), last.id]) : null,
  };
}

/** Relevance-ranked search through the configured engine (offset cursor). */
export async function searchStorefront(deps: CoreDeps, storeId: string, q: string, opts: { limit: number; cursor?: string | undefined }) {
  const offset = Number((decodeCursor(opts.cursor, 1) ?? [0])[0]) || 0;
  const { ids, total } = await searchEngine(deps).search(storeId, q, { limit: opts.limit, offset });
  if (ids.length === 0) return { items: [], total, nextCursor: null };
  const rows = await deps.db.select().from(products).where(and(eq(products.storeId, storeId), eq(products.status, "active"), inArray(products.id, ids)));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const ordered = ids.map((id) => byId.get(id)).filter((r): r is Row => !!r);
  return {
    items: await cards(deps, ordered),
    total,
    nextCursor: offset + ids.length < total ? encodeCursor([offset + ids.length]) : null,
  };
}
