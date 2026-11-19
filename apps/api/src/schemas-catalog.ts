import { COLLECTION_SORTS, PRODUCT_SORTS, STOREFRONT_SORTS } from "@shopkit/core";
import { INVENTORY_REASONS } from "@shopkit/db";
import { z } from "zod";

/** Response schemas for catalog endpoints (OpenAPI components; the SDK is generated from them). */
const money = z.number().int();
const weightUnit = z.enum(["kg", "g", "lb", "oz"]);
const status = z.enum(["draft", "active", "archived"]);

export const mediaViewSchema = z
  .object({
    id: z.uuid(),
    url: z.string(),
    alt: z.string().nullable(),
    width: z.number().int().nullable(),
    height: z.number().int().nullable(),
    contentType: z.string(),
    status: z.enum(["pending", "ready", "failed"]),
    processed: z.boolean(),
    sources: z.array(z.object({ width: z.number().int(), format: z.enum(["webp", "avif"]), url: z.string() })),
  })
  .meta({ id: "Media" });

export const uploadTargetSchema = z
  .object({
    mediaId: z.uuid().nullable(),
    upload: z.object({ url: z.string(), method: z.literal("PUT"), headers: z.record(z.string(), z.string()) }).nullable(),
  })
  .meta({ id: "MediaUploadTarget" });

const metafieldSchema = z
  .object({ namespace: z.string(), key: z.string(), type: z.string(), value: z.unknown() })
  .meta({ id: "Metafield" });

const levelSchema = z.object({ locationId: z.uuid(), available: z.number().int(), committed: z.number().int(), incoming: z.number().int() });

export const productAdminSchema = z
  .object({
    id: z.uuid(),
    title: z.string(),
    handle: z.string(),
    descriptionHtml: z.string(),
    status,
    vendor: z.string().nullable(),
    productType: z.string().nullable(),
    tags: z.array(z.string()),
    seoTitle: z.string().nullable(),
    seoDescription: z.string().nullable(),
    currency: z.string(),
    priceMin: money,
    priceMax: money,
    available: z.boolean(),
    totalInventory: z.number().int(),
    options: z.array(z.object({ id: z.uuid(), name: z.string(), position: z.number().int(), values: z.array(z.string()) })),
    variants: z.array(
      z.object({
        id: z.uuid(),
        title: z.string(),
        position: z.number().int(),
        options: z.array(z.string()),
        price: money,
        compareAtPrice: money.nullable(),
        cost: money.nullable(),
        currency: z.string(),
        sku: z.string().nullable(),
        barcode: z.string().nullable(),
        weight: z.number().nullable(),
        weightUnit,
        requiresShipping: z.boolean(),
        taxable: z.boolean(),
        hsnCode: z.string().nullable(),
        inventoryPolicy: z.enum(["deny", "continue"]),
        imageMediaId: z.uuid().nullable(),
        inventoryItemId: z.uuid().nullable(),
        tracked: z.boolean(),
        inventory: z.array(levelSchema),
      }),
    ),
    media: z.array(mediaViewSchema),
    metafields: z.array(metafieldSchema),
    collections: z.array(z.object({ id: z.uuid(), title: z.string(), handle: z.string(), type: z.enum(["manual", "smart"]) })),
    publishedAt: z.string().nullable(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .meta({ id: "ProductAdmin" });

export const productListSchema = z
  .object({
    items: z.array(
      z.object({
        id: z.uuid(),
        title: z.string(),
        handle: z.string(),
        status,
        vendor: z.string().nullable(),
        productType: z.string().nullable(),
        priceMin: money,
        priceMax: money,
        currency: z.string(),
        available: z.boolean(),
        totalInventory: z.number().int(),
        variantsCount: z.number().int(),
        image: mediaViewSchema.nullable(),
        updatedAt: z.string(),
      }),
    ),
    nextCursor: z.string().nullable(),
  })
  .meta({ id: "ProductList" });

export const productListQuerySchema = z.object({
  q: z.string().max(200).optional(),
  status: status.optional(),
  vendor: z.string().max(255).optional(),
  productType: z.string().max(255).optional(),
  tag: z.string().max(255).optional(),
  collectionId: z.uuid().optional(),
  availability: z.enum(["in_stock", "out_of_stock"]).optional(),
  sort: z.enum(PRODUCT_SORTS).optional(),
  limit: z.coerce.number().int().min(1).max(250).optional(),
  cursor: z.string().max(500).optional(),
});

export const savedViewSchema = z
  .object({ id: z.uuid(), name: z.string(), filters: z.record(z.string(), z.unknown()), createdAt: z.string() })
  .meta({ id: "SavedView" });

export const facetsSchema = z
  .object({ vendors: z.array(z.string()), productTypes: z.array(z.string()), tags: z.array(z.string()) })
  .meta({ id: "CatalogFacets" });

const ruleSchema = z.object({ field: z.string(), relation: z.string(), value: z.string() });
const productRef = z.object({ id: z.uuid(), title: z.string(), handle: z.string(), status, image: mediaViewSchema.nullable() });

export const collectionAdminSchema = z
  .object({
    id: z.uuid(),
    title: z.string(),
    handle: z.string(),
    descriptionHtml: z.string(),
    type: z.enum(["manual", "smart"]),
    rules: z.object({ match: z.enum(["all", "any"]), conditions: z.array(ruleSchema) }).nullable(),
    sortOrder: z.enum(COLLECTION_SORTS),
    image: mediaViewSchema.nullable(),
    seoTitle: z.string().nullable(),
    seoDescription: z.string().nullable(),
    published: z.boolean(),
    productsCount: z.number().int(),
    products: z.array(productRef),
    metafields: z.array(metafieldSchema),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .meta({ id: "CollectionAdmin" });

export const collectionListSchema = z
  .array(
    z.object({
      id: z.uuid(),
      title: z.string(),
      handle: z.string(),
      type: z.enum(["manual", "smart"]),
      sortOrder: z.enum(COLLECTION_SORTS),
      published: z.boolean(),
      productsCount: z.number().int(),
      image: mediaViewSchema.nullable(),
      updatedAt: z.string(),
    }),
  )
  .meta({ id: "CollectionList" });

const address = z.object({
  line1: z.string().optional(),
  line2: z.string().optional(),
  city: z.string().optional(),
  province: z.string().optional(),
  postalCode: z.string().optional(),
  country: z.string().optional(),
});

export const locationSchema = z
  .object({ id: z.uuid(), name: z.string(), address, isDefault: z.boolean(), active: z.boolean() })
  .meta({ id: "Location" });

export const inventoryPageSchema = z
  .object({
    items: z.array(
      z.object({
        variantId: z.uuid(),
        productId: z.uuid(),
        productTitle: z.string(),
        variantTitle: z.string(),
        sku: z.string().nullable(),
        inventoryItemId: z.uuid(),
        tracked: z.boolean(),
        inventoryPolicy: z.enum(["deny", "continue"]),
        available: z.number().int(),
        committed: z.number().int(),
        incoming: z.number().int(),
        featuredMediaId: z.uuid().nullable(),
      }),
    ),
    nextCursor: z.string().nullable(),
  })
  .meta({ id: "InventoryPage" });

export const adjustmentSchema = z
  .object({
    id: z.uuid(),
    locationId: z.uuid(),
    locationName: z.string(),
    quantity: z.enum(["available", "committed", "incoming"]),
    delta: z.number().int(),
    quantityAfter: z.number().int(),
    reason: z.enum(INVENTORY_REASONS),
    note: z.string().nullable(),
    actorType: z.string(),
    actorId: z.uuid().nullable(),
    createdAt: z.string(),
  })
  .meta({ id: "InventoryAdjustment" });

export const metafieldDefinitionSchema = z
  .object({ id: z.uuid(), ownerType: z.enum(["product", "variant", "collection"]), namespace: z.string(), key: z.string(), name: z.string(), type: z.string(), description: z.string().nullable() })
  .meta({ id: "MetafieldDefinition" });

export const jobSchema = z
  .object({
    id: z.uuid(),
    type: z.enum(["product_import", "product_export", "media_migration"]),
    status: z.enum(["queued", "running", "completed", "failed"]),
    processed: z.number().int(),
    total: z.number().int().nullable(),
    errorCount: z.number().int(),
    result: z.record(z.string(), z.unknown()),
    filename: z.string().nullable(),
    createdAt: z.string(),
    startedAt: z.string().nullable(),
    finishedAt: z.string().nullable(),
    errors: z.array(z.object({ line: z.number().int().optional(), ref: z.string().optional(), message: z.string() })).optional(),
  })
  .meta({ id: "Job" });

// ── Storefront ───────────────────────────────────────────────────────────────
export const productCardSchema = z
  .object({
    id: z.uuid(),
    handle: z.string(),
    title: z.string(),
    vendor: z.string().nullable(),
    productType: z.string().nullable(),
    priceMin: money,
    priceMax: money,
    compareAtPriceMax: money.nullable(),
    currency: z.string(),
    available: z.boolean(),
    image: mediaViewSchema.nullable(),
  })
  .meta({ id: "ProductCard" });

export const productPageSchema = z
  .object({ items: z.array(productCardSchema), nextCursor: z.string().nullable() })
  .meta({ id: "ProductCardPage" });

export const storefrontProductSchema = z
  .object({
    id: z.uuid(),
    handle: z.string(),
    title: z.string(),
    descriptionHtml: z.string(),
    vendor: z.string().nullable(),
    productType: z.string().nullable(),
    tags: z.array(z.string()),
    seo: z.object({ title: z.string(), description: z.string().nullable() }),
    currency: z.string(),
    priceMin: money,
    priceMax: money,
    compareAtPriceMax: money.nullable(),
    available: z.boolean(),
    options: z.array(z.object({ name: z.string(), values: z.array(z.string()) })),
    variants: z.array(
      z.object({
        id: z.uuid(),
        title: z.string(),
        options: z.array(z.string()),
        price: money,
        compareAtPrice: money.nullable(),
        currency: z.string(),
        sku: z.string().nullable(),
        available: z.boolean(),
        imageId: z.uuid().nullable(),
        requiresShipping: z.boolean(),
      }),
    ),
    images: z.array(mediaViewSchema),
    publishedAt: z.string().nullable(),
    updatedAt: z.string(),
  })
  .meta({ id: "StorefrontProduct" });

export const storefrontCollectionSchema = z
  .object({
    id: z.uuid(),
    handle: z.string(),
    title: z.string(),
    descriptionHtml: z.string(),
    sortOrder: z.enum(COLLECTION_SORTS),
    image: mediaViewSchema.nullable(),
    seo: z.object({ title: z.string(), description: z.string().nullable() }),
    productsCount: z.number().int(),
    updatedAt: z.string(),
  })
  .meta({ id: "StorefrontCollection" });

export const storefrontCollectionListSchema = z
  .object({
    items: z.array(z.object({ id: z.uuid(), handle: z.string(), title: z.string(), productsCount: z.number().int(), image: mediaViewSchema.nullable() })),
    nextCursor: z.string().nullable(),
  })
  .meta({ id: "StorefrontCollectionList" });

export const storefrontFacetsSchema = z
  .object({
    price: z.object({ min: money, max: money }),
    tags: z.array(z.object({ value: z.string(), count: z.number().int() })),
    vendors: z.array(z.object({ value: z.string(), count: z.number().int() })),
    options: z.array(z.object({ name: z.string(), values: z.array(z.object({ value: z.string(), count: z.number().int() })) })),
  })
  .meta({ id: "StorefrontFacets" });

export const searchResultSchema = z
  .object({ items: z.array(productCardSchema), total: z.number().int(), nextCursor: z.string().nullable() })
  .meta({ id: "SearchResult" });

const list = z.union([z.string(), z.array(z.string())]).optional();
export const storefrontListQuerySchema = z.object({
  sort: z.enum(STOREFRONT_SORTS).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().max(500).optional(),
  priceMin: z.coerce.number().int().min(0).optional(),
  priceMax: z.coerce.number().int().min(0).optional(),
  available: z.enum(["true", "false"]).optional(),
  tag: list,
  vendor: list,
  productType: list,
  option: list.describe('Option filter "Name:Value"; repeat for more values'),
});
