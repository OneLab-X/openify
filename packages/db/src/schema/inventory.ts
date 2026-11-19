import { boolean, index, integer, pgEnum, pgTable, primaryKey, text, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { createdAt, pk, updatedAt } from "./columns.js";
import { productVariants } from "./catalog.js";
import { locations, stores } from "./stores.js";

/** One per variant (SPEC §8 inventory). `tracked` = "Track quantity". */
export const inventoryItems = pgTable(
  "inventory_items",
  {
    id: pk(),
    storeId: uuid()
      .notNull()
      .references(() => stores.id, { onDelete: "cascade" }),
    variantId: uuid()
      .notNull()
      .references(() => productVariants.id, { onDelete: "cascade" }),
    tracked: boolean().notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("inventory_items_variant_uq").on(t.variantId), index("inventory_items_store_idx").on(t.storeId)],
);

export const inventoryLevels = pgTable(
  "inventory_levels",
  {
    storeId: uuid()
      .notNull()
      .references(() => stores.id, { onDelete: "cascade" }),
    inventoryItemId: uuid()
      .notNull()
      .references(() => inventoryItems.id, { onDelete: "cascade" }),
    locationId: uuid()
      .notNull()
      .references(() => locations.id, { onDelete: "cascade" }),
    available: integer().notNull().default(0),
    committed: integer().notNull().default(0),
    incoming: integer().notNull().default(0),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.inventoryItemId, t.locationId] }), index("inventory_levels_location_idx").on(t.storeId, t.locationId)],
);

export const INVENTORY_REASONS = [
  "received",
  "correction",
  "cycle_count",
  "damaged",
  "theft_or_loss",
  "promotion",
  "restock",
  "import",
  "order",
  "other",
] as const;
export type InventoryReason = (typeof INVENTORY_REASONS)[number];
export const inventoryReason = pgEnum("inventory_reason", INVENTORY_REASONS);
export const inventoryQuantity = pgEnum("inventory_quantity", ["available", "committed", "incoming"]);

/** Append-only ledger: every change to a level writes one row per quantity changed. */
export const inventoryAdjustments = pgTable(
  "inventory_adjustments",
  {
    id: pk(),
    storeId: uuid()
      .notNull()
      .references(() => stores.id, { onDelete: "cascade" }),
    inventoryItemId: uuid()
      .notNull()
      .references(() => inventoryItems.id, { onDelete: "cascade" }),
    locationId: uuid()
      .notNull()
      .references(() => locations.id, { onDelete: "cascade" }),
    quantity: inventoryQuantity().notNull(),
    delta: integer().notNull(),
    quantityAfter: integer().notNull(),
    reason: inventoryReason().notNull(),
    note: text(),
    actorType: text().$type<"staff" | "setup" | "system" | "api_key">().notNull(),
    actorId: uuid(),
    createdAt: createdAt(),
  },
  (t) => [index("inventory_adjustments_item_idx").on(t.inventoryItemId, t.createdAt.desc())],
);
