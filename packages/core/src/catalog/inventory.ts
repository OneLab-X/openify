import {
  and,
  asc,
  desc,
  eq,
  inArray,
  INVENTORY_REASONS,
  inventoryAdjustments,
  inventoryItems,
  inventoryLevels,
  locations,
  lt,
  productVariants,
  products,
  sql,
  type Executor,
  type InventoryReason,
} from "@shopkit/db";
import { z } from "zod";
import { writeAudit } from "../audit.js";
import type { Actor, CoreDeps } from "../deps.js";
import { AppError, notFound } from "../errors.js";
import { addressSchema } from "../stores.js";

export const QUANTITY_NAMES = ["available", "committed", "incoming"] as const;
export type QuantityName = (typeof QUANTITY_NAMES)[number];

// ── Locations ────────────────────────────────────────────────────────────────
export const locationInput = z.object({
  name: z.string().trim().min(1).max(120),
  address: addressSchema.default({}),
  active: z.boolean().default(true),
});
export type LocationInput = z.input<typeof locationInput>;

/** Inventory needs at least one location; setup step 7 is skippable, so create one on demand. */
export async function ensureDefaultLocation(tx: Executor, storeId: string): Promise<string> {
  const [existing] = await tx
    .select({ id: locations.id })
    .from(locations)
    .where(eq(locations.storeId, storeId))
    .orderBy(desc(locations.isDefault), asc(locations.createdAt))
    .limit(1);
  if (existing) return existing.id;
  const [row] = await tx.insert(locations).values({ storeId, name: "Default location", isDefault: true }).returning({ id: locations.id });
  return row!.id;
}

export async function listLocations(db: Executor, storeId: string) {
  return db.select().from(locations).where(eq(locations.storeId, storeId)).orderBy(desc(locations.isDefault), asc(locations.name));
}

export async function createLocation(deps: CoreDeps, actor: Actor, storeId: string, input: LocationInput) {
  const data = locationInput.parse(input);
  return deps.db.transaction(async (tx) => {
    const hasAny = (await tx.select({ id: locations.id }).from(locations).where(eq(locations.storeId, storeId)).limit(1)).length > 0;
    const [row] = await tx.insert(locations).values({ storeId, ...data, isDefault: !hasAny }).returning();
    await writeAudit(tx, actor, { storeId, action: "location.created", resourceType: "location", resourceId: row!.id });
    return row!;
  });
}

export async function updateLocation(deps: CoreDeps, actor: Actor, storeId: string, id: string, input: LocationInput & { isDefault?: boolean }) {
  const data = locationInput.parse(input);
  return deps.db.transaction(async (tx) => {
    if (input.isDefault) await tx.update(locations).set({ isDefault: false }).where(eq(locations.storeId, storeId));
    const [row] = await tx
      .update(locations)
      .set({ ...data, ...(input.isDefault ? { isDefault: true, active: true } : {}) })
      .where(and(eq(locations.storeId, storeId), eq(locations.id, id)))
      .returning();
    if (!row) throw notFound("Location");
    if (row.isDefault && !row.active) throw new AppError("validation_failed", "The default location must stay active");
    await writeAudit(tx, actor, { storeId, action: "location.updated", resourceType: "location", resourceId: id });
    return row;
  });
}

// ── Items and levels ─────────────────────────────────────────────────────────
export async function ensureInventoryItem(tx: Executor, storeId: string, variantId: string, tracked: boolean): Promise<string> {
  const [row] = await tx
    .insert(inventoryItems)
    .values({ storeId, variantId, tracked })
    .onConflictDoUpdate({ target: inventoryItems.variantId, set: { tracked } })
    .returning({ id: inventoryItems.id });
  return row!.id;
}

export interface QuantityChange {
  inventoryItemId: string;
  locationId: string;
  quantity: QuantityName;
  /** Either an absolute value or a delta. */
  set?: number;
  delta?: number;
}

/**
 * Applies changes to inventory levels and writes one ledger row per change. Rows are locked
 * (`for update`) so concurrent adjustments serialise; a "set" to the current value is a no-op.
 * Returns the product ids whose aggregates must be refreshed.
 */
export async function applyInventoryChanges(
  tx: Executor,
  actor: Actor,
  storeId: string,
  changes: QuantityChange[],
  reason: InventoryReason,
  note?: string | null,
): Promise<string[]> {
  if (changes.length === 0) return [];
  const itemIds = [...new Set(changes.map((c) => c.inventoryItemId))];
  const items = await tx
    .select({ id: inventoryItems.id, productId: productVariants.productId })
    .from(inventoryItems)
    .innerJoin(productVariants, eq(productVariants.id, inventoryItems.variantId))
    .where(and(eq(inventoryItems.storeId, storeId), inArray(inventoryItems.id, itemIds)));
  if (items.length !== itemIds.length) throw notFound("Inventory item");
  const locationIds = [...new Set(changes.map((c) => c.locationId))];
  const locs = await tx.select({ id: locations.id }).from(locations).where(and(eq(locations.storeId, storeId), inArray(locations.id, locationIds)));
  if (locs.length !== locationIds.length) throw notFound("Location");

  for (const c of changes) {
    await tx.insert(inventoryLevels).values({ storeId, inventoryItemId: c.inventoryItemId, locationId: c.locationId }).onConflictDoNothing();
    const [level] = await tx
      .select()
      .from(inventoryLevels)
      .where(and(eq(inventoryLevels.inventoryItemId, c.inventoryItemId), eq(inventoryLevels.locationId, c.locationId)))
      .for("update");
    const current = level![c.quantity];
    const next = c.set !== undefined ? c.set : current + (c.delta ?? 0);
    if (!Number.isInteger(next) || Math.abs(next) > 1_000_000_000) throw new AppError("validation_failed", "Quantity is out of range");
    if (next === current) continue;
    await tx
      .update(inventoryLevels)
      .set({ [c.quantity]: next })
      .where(and(eq(inventoryLevels.inventoryItemId, c.inventoryItemId), eq(inventoryLevels.locationId, c.locationId)));
    await tx.insert(inventoryAdjustments).values({
      storeId,
      inventoryItemId: c.inventoryItemId,
      locationId: c.locationId,
      quantity: c.quantity,
      delta: next - current,
      quantityAfter: next,
      reason,
      note: note ?? null,
      actorType: actor.type,
      actorId: actor.id ?? null,
    });
  }
  return [...new Set(items.map((i) => i.productId))];
}

export const adjustmentInput = z.object({
  reason: z.enum(INVENTORY_REASONS).default("correction"),
  note: z.string().trim().max(500).optional(),
  changes: z
    .array(
      z
        .object({
          inventoryItemId: z.uuid(),
          locationId: z.uuid(),
          quantity: z.enum(QUANTITY_NAMES).default("available"),
          set: z.number().int().min(-1_000_000).max(1_000_000_000).optional(),
          delta: z.number().int().min(-1_000_000_000).max(1_000_000_000).optional(),
        })
        .refine((c) => (c.set === undefined) !== (c.delta === undefined), "Give either set or delta"),
    )
    .min(1)
    .max(500),
});
export type AdjustmentInput = z.input<typeof adjustmentInput>;

// ── Queries ──────────────────────────────────────────────────────────────────
export const inventoryListQuery = z.object({
  locationId: z.uuid(),
  q: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(250).default(50),
  cursor: z.string().max(200).optional(),
});

/** Inventory page: one row per variant at a location (cursor = product title + variant id). */
export async function listInventory(db: Executor, storeId: string, query: z.input<typeof inventoryListQuery>) {
  const { locationId, q, limit, cursor } = inventoryListQuery.parse(query);
  const after = cursor ? (JSON.parse(Buffer.from(cursor, "base64url").toString()) as [string, number, string]) : null;
  const like = q ? `%${q.replace(/[\\%_]/g, "\\$&")}%` : null;
  const rows = await db.execute<{
    variant_id: string;
    product_id: string;
    product_title: string;
    variant_title: string;
    variant_position: number;
    sku: string | null;
    inventory_item_id: string;
    tracked: boolean;
    inventory_policy: "deny" | "continue";
    available: number | null;
    committed: number | null;
    incoming: number | null;
    featured_media_id: string | null;
  }>(sql`
    select v.id as variant_id, p.id as product_id, p.title as product_title, v.title as variant_title, v.position as variant_position,
           v.sku, ii.id as inventory_item_id, ii.tracked, v.inventory_policy, l.available, l.committed, l.incoming, p.featured_media_id
    from ${productVariants} v
    join ${products} p on p.id = v.product_id
    join ${inventoryItems} ii on ii.variant_id = v.id
    left join ${inventoryLevels} l on l.inventory_item_id = ii.id and l.location_id = ${locationId}
    where v.store_id = ${storeId} and p.status <> 'archived'
      ${like ? sql`and (p.title ilike ${like} or v.sku ilike ${like} or v.title ilike ${like})` : sql``}
      ${after ? sql`and (p.title, v.position, v.id) > (${after[0]}, ${after[1]}, ${after[2]}::uuid)` : sql``}
    order by p.title, v.position, v.id
    limit ${limit + 1}`);
  const page = rows.rows.slice(0, limit);
  const last = page.at(-1);
  return {
    items: page.map((r) => ({
      variantId: r.variant_id,
      productId: r.product_id,
      productTitle: r.product_title,
      variantTitle: r.variant_title,
      sku: r.sku,
      inventoryItemId: r.inventory_item_id,
      tracked: r.tracked,
      inventoryPolicy: r.inventory_policy,
      available: r.available ?? 0,
      committed: r.committed ?? 0,
      incoming: r.incoming ?? 0,
      featuredMediaId: r.featured_media_id,
    })),
    nextCursor:
      rows.rows.length > limit && last
        ? Buffer.from(JSON.stringify([last.product_title, last.variant_position, last.variant_id])).toString("base64url")
        : null,
  };
}

export async function listAdjustments(db: Executor, storeId: string, inventoryItemId: string, opts: { limit: number; before?: Date }) {
  return db
    .select({
      id: inventoryAdjustments.id,
      locationId: inventoryAdjustments.locationId,
      locationName: locations.name,
      quantity: inventoryAdjustments.quantity,
      delta: inventoryAdjustments.delta,
      quantityAfter: inventoryAdjustments.quantityAfter,
      reason: inventoryAdjustments.reason,
      note: inventoryAdjustments.note,
      actorType: inventoryAdjustments.actorType,
      actorId: inventoryAdjustments.actorId,
      createdAt: inventoryAdjustments.createdAt,
    })
    .from(inventoryAdjustments)
    .innerJoin(locations, eq(locations.id, inventoryAdjustments.locationId))
    .where(
      and(
        eq(inventoryAdjustments.storeId, storeId),
        eq(inventoryAdjustments.inventoryItemId, inventoryItemId),
        opts.before ? lt(inventoryAdjustments.createdAt, opts.before) : undefined,
      ),
    )
    .orderBy(desc(inventoryAdjustments.createdAt), desc(inventoryAdjustments.id))
    .limit(opts.limit);
}

/** Levels for a set of variants, keyed by variant id (admin product view). */
export async function levelsForVariants(db: Executor, variantIds: string[]) {
  if (variantIds.length === 0) return new Map<string, { inventoryItemId: string; tracked: boolean; levels: { locationId: string; available: number; committed: number; incoming: number }[] }>();
  const rows = await db
    .select({
      variantId: inventoryItems.variantId,
      inventoryItemId: inventoryItems.id,
      tracked: inventoryItems.tracked,
      locationId: inventoryLevels.locationId,
      available: inventoryLevels.available,
      committed: inventoryLevels.committed,
      incoming: inventoryLevels.incoming,
    })
    .from(inventoryItems)
    .leftJoin(inventoryLevels, eq(inventoryLevels.inventoryItemId, inventoryItems.id))
    .where(inArray(inventoryItems.variantId, variantIds));
  const out = new Map<string, { inventoryItemId: string; tracked: boolean; levels: { locationId: string; available: number; committed: number; incoming: number }[] }>();
  for (const r of rows) {
    const entry = out.get(r.variantId) ?? { inventoryItemId: r.inventoryItemId, tracked: r.tracked, levels: [] };
    if (r.locationId) entry.levels.push({ locationId: r.locationId, available: r.available ?? 0, committed: r.committed ?? 0, incoming: r.incoming ?? 0 });
    out.set(r.variantId, entry);
  }
  return out;
}
