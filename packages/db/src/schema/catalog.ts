import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  char,
  customType,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { citext, createdAt, pk, updatedAt } from "./columns.js";
import { media } from "./platform.js";
import { stores } from "./stores.js";
import { staffUsers } from "./staff.js";

const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });

const storeRef = () =>
  uuid()
    .notNull()
    .references(() => stores.id, { onDelete: "cascade" });

export const productStatus = pgEnum("product_status", ["draft", "active", "archived"]);
export const inventoryPolicy = pgEnum("inventory_policy", ["deny", "continue"]);

/**
 * SPEC §8 catalog. `price_min/price_max/available/total_inventory` are denormalised from variants and
 * inventory levels (kept current by packages/core) so listing, filtering and sorting stay single-table.
 */
export const products = pgTable(
  "products",
  {
    id: pk(),
    storeId: storeRef(),
    title: text().notNull(),
    handle: citext().notNull(),
    descriptionHtml: text().notNull().default(""),
    status: productStatus().notNull().default("draft"),
    vendor: text(),
    productType: text(),
    seoTitle: text(),
    seoDescription: text(),
    currency: char({ length: 3 }).notNull(),
    priceMin: bigint({ mode: "number" }).notNull().default(0),
    priceMax: bigint({ mode: "number" }).notNull().default(0),
    compareAtPriceMax: bigint({ mode: "number" }),
    available: boolean().notNull().default(false),
    totalInventory: integer().notNull().default(0),
    featuredMediaId: uuid().references(() => media.id, { onDelete: "set null" }),
    /** Weighted: title A, vendor/type/tags B, SKUs/barcodes B, description C. Maintained by core. */
    searchVector: tsvector(),
    publishedAt: timestamp({ withTimezone: true }),
    archivedAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("products_store_handle_uq").on(t.storeId, t.handle),
    index("products_store_status_idx").on(t.storeId, t.status, t.createdAt.desc(), t.id.desc()),
    index("products_store_price_idx").on(t.storeId, t.priceMin),
    index("products_search_idx").using("gin", t.searchVector),
    index("products_title_trgm_idx").using("gin", sql`${t.title} gin_trgm_ops`),
  ],
);

export const productOptions = pgTable(
  "product_options",
  {
    id: pk(),
    storeId: storeRef(),
    productId: uuid()
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    name: text().notNull(),
    /** 1..3, matches product_variants.option1..option3. */
    position: integer().notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("product_options_position_uq").on(t.productId, t.position)],
);

export const productOptionValues = pgTable(
  "product_option_values",
  {
    id: pk(),
    storeId: storeRef(),
    optionId: uuid()
      .notNull()
      .references(() => productOptions.id, { onDelete: "cascade" }),
    value: text().notNull(),
    position: integer().notNull(),
  },
  (t) => [uniqueIndex("product_option_values_uq").on(t.optionId, t.value)],
);

export const productVariants = pgTable(
  "product_variants",
  {
    id: pk(),
    storeId: storeRef(),
    productId: uuid()
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    title: text().notNull(),
    position: integer().notNull(),
    option1: text(),
    option2: text(),
    option3: text(),
    /** Money: integer minor units of `currency` (SPEC §8). */
    price: bigint({ mode: "number" }).notNull(),
    compareAtPrice: bigint({ mode: "number" }),
    cost: bigint({ mode: "number" }),
    currency: char({ length: 3 }).notNull(),
    sku: text(),
    barcode: text(),
    weight: doublePrecision(),
    weightUnit: text().$type<"kg" | "g" | "lb" | "oz">().notNull().default("kg"),
    requiresShipping: boolean().notNull().default(true),
    taxable: boolean().notNull().default(true),
    hsnCode: text(),
    inventoryPolicy: inventoryPolicy().notNull().default("deny"),
    imageMediaId: uuid().references(() => media.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("product_variants_options_uq").on(t.productId, t.option1, t.option2, t.option3).nullsNotDistinct(),
    index("product_variants_product_idx").on(t.productId, t.position),
    index("product_variants_store_sku_idx").on(t.storeId, t.sku),
  ],
);

export const productMedia = pgTable(
  "product_media",
  {
    storeId: storeRef(),
    productId: uuid()
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    mediaId: uuid()
      .notNull()
      .references(() => media.id, { onDelete: "cascade" }),
    position: integer().notNull(),
  },
  (t) => [primaryKey({ columns: [t.productId, t.mediaId] }), index("product_media_media_idx").on(t.mediaId)],
);

export const tags = pgTable(
  "tags",
  {
    id: pk(),
    storeId: storeRef(),
    name: citext().notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("tags_store_name_uq").on(t.storeId, t.name)],
);

export const productTags = pgTable(
  "product_tags",
  {
    storeId: storeRef(),
    productId: uuid()
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    tagId: uuid()
      .notNull()
      .references(() => tags.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.productId, t.tagId] }), index("product_tags_tag_idx").on(t.tagId)],
);

/** Vendor and product-type lists for admin autocomplete; products keep the text value. */
export const vendors = pgTable(
  "vendors",
  { id: pk(), storeId: storeRef(), name: citext().notNull(), createdAt: createdAt() },
  (t) => [uniqueIndex("vendors_store_name_uq").on(t.storeId, t.name)],
);

export const productTypes = pgTable(
  "product_types",
  { id: pk(), storeId: storeRef(), name: citext().notNull(), createdAt: createdAt() },
  (t) => [uniqueIndex("product_types_store_name_uq").on(t.storeId, t.name)],
);

export const collectionType = pgEnum("collection_type", ["manual", "smart"]);
export const collectionSort = pgEnum("collection_sort", [
  "manual",
  "best_selling",
  "title_asc",
  "title_desc",
  "price_asc",
  "price_desc",
  "created_desc",
  "created_asc",
]);

export interface CollectionRule {
  field: "tag" | "title" | "type" | "vendor" | "price" | "compare_at_price" | "inventory";
  relation: "equals" | "not_equals" | "starts_with" | "ends_with" | "contains" | "not_contains" | "greater_than" | "less_than";
  value: string;
}
export interface CollectionRules {
  match: "all" | "any";
  conditions: CollectionRule[];
}

export const collections = pgTable(
  "collections",
  {
    id: pk(),
    storeId: storeRef(),
    title: text().notNull(),
    handle: citext().notNull(),
    descriptionHtml: text().notNull().default(""),
    type: collectionType().notNull().default("manual"),
    rules: jsonb().$type<CollectionRules>(),
    sortOrder: collectionSort().notNull().default("manual"),
    imageMediaId: uuid().references(() => media.id, { onDelete: "set null" }),
    seoTitle: text(),
    seoDescription: text(),
    published: boolean().notNull().default(true),
    productsCount: integer().notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("collections_store_handle_uq").on(t.storeId, t.handle)],
);

/** Membership for both kinds. Smart collections are materialised here by core on every change. */
export const collectionProducts = pgTable(
  "collection_products",
  {
    storeId: storeRef(),
    collectionId: uuid()
      .notNull()
      .references(() => collections.id, { onDelete: "cascade" }),
    productId: uuid()
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    position: integer().notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.collectionId, t.productId] }),
    index("collection_products_product_idx").on(t.productId),
    index("collection_products_position_idx").on(t.collectionId, t.position),
  ],
);

export const metafieldOwner = pgEnum("metafield_owner", ["product", "variant", "collection"]);
export const METAFIELD_TYPES = [
  "single_line_text",
  "multi_line_text",
  "number_integer",
  "number_decimal",
  "boolean",
  "url",
  "date",
  "json",
] as const;
export type MetafieldType = (typeof METAFIELD_TYPES)[number];

export const metafieldDefinitions = pgTable(
  "metafield_definitions",
  {
    id: pk(),
    storeId: storeRef(),
    ownerType: metafieldOwner().notNull(),
    namespace: text().notNull(),
    key: text().notNull(),
    name: text().notNull(),
    type: text().$type<MetafieldType>().notNull(),
    description: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("metafield_definitions_uq").on(t.storeId, t.ownerType, t.namespace, t.key)],
);

export const metafields = pgTable(
  "metafields",
  {
    id: pk(),
    storeId: storeRef(),
    ownerType: metafieldOwner().notNull(),
    ownerId: uuid().notNull(),
    namespace: text().notNull(),
    key: text().notNull(),
    type: text().$type<MetafieldType>().notNull(),
    value: jsonb().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("metafields_owner_uq").on(t.ownerType, t.ownerId, t.namespace, t.key), index("metafields_store_idx").on(t.storeId)],
);

/** Saved admin list filters ("views"). Not in SPEC §8; see DECISIONS.md. */
export const savedViews = pgTable(
  "saved_views",
  {
    id: pk(),
    storeId: storeRef(),
    resource: text().$type<"products">().notNull(),
    name: text().notNull(),
    filters: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    createdBy: uuid().references(() => staffUsers.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("saved_views_name_uq").on(t.storeId, t.resource, t.name)],
);
