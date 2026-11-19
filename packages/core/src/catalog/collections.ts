import { and, asc, collectionProducts, collections, desc, eq, inArray, media, products, sql, type Executor } from "@shopkit/db";
import { z } from "zod";
import { writeAudit } from "../audit.js";
import type { Actor, CoreDeps } from "../deps.js";
import { AppError, notFound } from "../errors.js";
import { enqueueEvent } from "../outbox.js";
import { HANDLE_RE, slugify, uniqueHandle } from "./handles.js";
import { sanitizeHtml } from "./html.js";
import { mediaByIds, mediaView } from "./media-view.js";
import { metafieldInput, metafieldsFor, replaceMetafields } from "./metafields.js";
import { syncSmartCollection, updateCollectionCount } from "./refresh.js";
import { collectionRulesSchema } from "./rules.js";

export const COLLECTION_SORTS = ["manual", "best_selling", "title_asc", "title_desc", "price_asc", "price_desc", "created_desc", "created_asc"] as const;

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v ? v : null));

export const collectionInput = z
  .object({
    title: z.string().trim().min(1, "Title is required").max(255),
    handle: z.string().trim().max(255).optional(),
    descriptionHtml: z.string().max(256_000).default(""),
    type: z.enum(["manual", "smart"]).default("manual"),
    rules: collectionRulesSchema.nullish(),
    sortOrder: z.enum(COLLECTION_SORTS).default("best_selling"),
    imageMediaId: z.uuid().nullish(),
    seoTitle: optionalText(255),
    seoDescription: optionalText(1000),
    published: z.boolean().default(true),
    /** Manual collections: the ordered product list (replaces membership). Omitted = unchanged. */
    productIds: z.array(z.uuid()).max(5000).optional(),
    metafields: z.array(metafieldInput).max(200).optional(),
  })
  .superRefine((c, ctx) => {
    if (c.type === "smart" && !c.rules) ctx.addIssue({ code: "custom", path: ["rules"], message: "Add at least one condition" });
    if (c.type === "smart" && c.productIds) ctx.addIssue({ code: "custom", path: ["productIds"], message: "Smart collections pick products by their conditions" });
  });
export type CollectionInput = z.input<typeof collectionInput>;

const issue = (path: string, message: string) => new AppError("validation_failed", "Check the highlighted fields", [{ path, message }]);

async function setManualProducts(tx: Executor, storeId: string, collectionId: string, productIds: string[]) {
  const ids = [...new Set(productIds)];
  if (ids.length) {
    const owned = await tx.select({ id: products.id }).from(products).where(and(eq(products.storeId, storeId), inArray(products.id, ids)));
    if (owned.length !== ids.length) throw issue("productIds", "Unknown product");
  }
  await tx.delete(collectionProducts).where(eq(collectionProducts.collectionId, collectionId));
  if (ids.length) {
    await tx.insert(collectionProducts).values(ids.map((productId, i) => ({ storeId, collectionId, productId, position: i + 1 })));
  }
  await updateCollectionCount(tx, collectionId);
}

export async function saveCollection(tx: Executor, actor: Actor, storeId: string, existingId: string | null, input: CollectionInput) {
  const data = collectionInput.parse(input);
  const [existing] = existingId
    ? await tx.select().from(collections).where(and(eq(collections.storeId, storeId), eq(collections.id, existingId))).for("update")
    : [];
  if (existingId && !existing) throw notFound("Collection");
  if (existing && existing.type !== data.type) throw issue("type", "A collection's type cannot change after it is created");
  if (data.type === "smart" && data.sortOrder === "manual") throw issue("sortOrder", "Smart collections cannot be sorted manually");

  let handle: string;
  if (data.handle) {
    handle = slugify(data.handle);
    if (!HANDLE_RE.test(handle)) throw issue("handle", "Use letters, numbers and hyphens");
    const [clash] = await tx.select({ id: collections.id }).from(collections).where(and(eq(collections.storeId, storeId), eq(collections.handle, handle)));
    if (clash && clash.id !== existingId) throw issue("handle", "Another collection already uses this handle");
  } else {
    handle = existing?.handle ?? (await uniqueHandle(tx, collections, storeId, slugify(data.title), existingId ?? undefined));
  }
  if (data.imageMediaId) {
    const [m] = await tx.select({ id: media.id }).from(media).where(and(eq(media.storeId, storeId), eq(media.id, data.imageMediaId)));
    if (!m) throw issue("imageMediaId", "Unknown image");
  }

  const values = {
    title: data.title,
    handle,
    descriptionHtml: await sanitizeHtml(data.descriptionHtml),
    type: data.type,
    rules: data.type === "smart" ? data.rules! : null,
    sortOrder: data.sortOrder,
    imageMediaId: data.imageMediaId ?? null,
    seoTitle: data.seoTitle,
    seoDescription: data.seoDescription,
    published: data.published,
  };
  let id: string;
  if (existing) {
    await tx.update(collections).set({ ...values, updatedAt: new Date() }).where(eq(collections.id, existing.id));
    id = existing.id;
  } else {
    const [row] = await tx.insert(collections).values({ storeId, ...values }).returning({ id: collections.id });
    id = row!.id;
  }
  if (data.type === "smart") await syncSmartCollection(tx, storeId, id, values.rules);
  else if (data.productIds) await setManualProducts(tx, storeId, id, data.productIds);
  if (data.metafields) await replaceMetafields(tx, storeId, "collection", id, data.metafields);

  const previousHandle = existing && existing.handle !== handle ? existing.handle : null;
  await enqueueEvent(tx, { storeId, type: existing ? "collection.updated" : "collection.created", payload: { collectionId: id, handle, previousHandle } });
  await writeAudit(tx, actor, { storeId, action: existing ? "collection.updated" : "collection.created", resourceType: "collection", resourceId: id });
  return id;
}

export async function createCollection(deps: CoreDeps, actor: Actor, storeId: string, input: CollectionInput) {
  const id = await deps.db.transaction((tx) => saveCollection(tx, actor, storeId, null, input));
  return getCollectionAdmin(deps, storeId, id);
}

export async function updateCollection(deps: CoreDeps, actor: Actor, storeId: string, id: string, input: CollectionInput) {
  await deps.db.transaction((tx) => saveCollection(tx, actor, storeId, id, input));
  return getCollectionAdmin(deps, storeId, id);
}

export async function deleteCollection(deps: CoreDeps, actor: Actor, storeId: string, id: string) {
  await deps.db.transaction(async (tx) => {
    const [row] = await tx.delete(collections).where(and(eq(collections.storeId, storeId), eq(collections.id, id))).returning();
    if (!row) throw notFound("Collection");
    await enqueueEvent(tx, { storeId, type: "collection.deleted", payload: { collectionId: id, handle: row.handle } });
    await writeAudit(tx, actor, { storeId, action: "collection.deleted", resourceType: "collection", resourceId: id });
  });
}

/** Adds products to (or removes them from) manual collections without a full save. */
export async function addProductsToCollection(deps: CoreDeps, actor: Actor, storeId: string, collectionId: string, productIds: string[]) {
  await deps.db.transaction(async (tx) => {
    const [c] = await tx.select().from(collections).where(and(eq(collections.storeId, storeId), eq(collections.id, collectionId))).for("update");
    if (!c) throw notFound("Collection");
    if (c.type !== "manual") throw new AppError("validation_failed", "Smart collections pick products by their conditions");
    const [max] = await tx.select({ n: sql<number>`coalesce(max(${collectionProducts.position}), 0)::int` }).from(collectionProducts).where(eq(collectionProducts.collectionId, collectionId));
    const owned = await tx.select({ id: products.id }).from(products).where(and(eq(products.storeId, storeId), inArray(products.id, productIds)));
    if (owned.length) {
      await tx
        .insert(collectionProducts)
        .values(owned.map((p, i) => ({ storeId, collectionId, productId: p.id, position: (max?.n ?? 0) + i + 1 })))
        .onConflictDoNothing();
    }
    await updateCollectionCount(tx, collectionId);
    await enqueueEvent(tx, { storeId, type: "collection.updated", payload: { collectionId, handle: c.handle } });
    await writeAudit(tx, actor, { storeId, action: "collection.products_added", resourceType: "collection", resourceId: collectionId, metadata: { count: owned.length } });
  });
}

// ── Admin views ──────────────────────────────────────────────────────────────
export async function getCollectionAdmin(deps: CoreDeps, storeId: string, id: string) {
  const [c] = await deps.db.select().from(collections).where(and(eq(collections.storeId, storeId), eq(collections.id, id)));
  if (!c) throw notFound("Collection");
  const members = await deps.db
    .select({ id: products.id, title: products.title, handle: products.handle, status: products.status, featuredMediaId: products.featuredMediaId, position: collectionProducts.position })
    .from(collectionProducts)
    .innerJoin(products, eq(products.id, collectionProducts.productId))
    .where(eq(collectionProducts.collectionId, id))
    .orderBy(c.type === "manual" ? asc(collectionProducts.position) : asc(products.title), asc(products.id))
    .limit(500);
  const mediaMap = await mediaByIds(deps.db, [c.imageMediaId ?? "", ...members.map((m) => m.featuredMediaId ?? "")]);
  const image = c.imageMediaId ? mediaMap.get(c.imageMediaId) : undefined;
  const metas = await metafieldsFor(deps.db, "collection", [id]);
  return {
    id: c.id,
    title: c.title,
    handle: c.handle,
    descriptionHtml: await sanitizeHtml(c.descriptionHtml),
    type: c.type,
    rules: c.rules,
    sortOrder: c.sortOrder,
    image: image ? mediaView(deps, image) : null,
    seoTitle: c.seoTitle,
    seoDescription: c.seoDescription,
    published: c.published,
    productsCount: c.productsCount,
    products: members.map((m) => {
      const img = m.featuredMediaId ? mediaMap.get(m.featuredMediaId) : undefined;
      return { id: m.id, title: m.title, handle: m.handle, status: m.status, image: img ? mediaView(deps, img) : null };
    }),
    metafields: metas.get(id) ?? [],
    createdAt: c.createdAt.toISOString(),
    updatedAt: c.updatedAt.toISOString(),
  };
}

export async function listCollectionsAdmin(deps: CoreDeps, storeId: string, opts: { q?: string | undefined; limit: number; offset?: number | undefined }) {
  const like = opts.q ? `%${opts.q.replace(/[\\%_]/g, "\\$&")}%` : null;
  const rows = await deps.db
    .select()
    .from(collections)
    .where(and(eq(collections.storeId, storeId), like ? sql`${collections.title} ilike ${like}` : undefined))
    .orderBy(asc(collections.title), desc(collections.id))
    .limit(opts.limit)
    .offset(opts.offset ?? 0);
  const mediaMap = await mediaByIds(deps.db, rows.map((r) => r.imageMediaId ?? ""));
  return rows.map((c) => {
    const img = c.imageMediaId ? mediaMap.get(c.imageMediaId) : undefined;
    return {
      id: c.id,
      title: c.title,
      handle: c.handle,
      type: c.type,
      sortOrder: c.sortOrder,
      published: c.published,
      productsCount: c.productsCount,
      image: img ? mediaView(deps, img) : null,
      updatedAt: c.updatedAt.toISOString(),
    };
  });
}
