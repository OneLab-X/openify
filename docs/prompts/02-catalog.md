# 02 — Catalog and media

Prepend `00-master-context.md`, then:

```
Phase 2 — Catalog and media. Read SPEC §7 (StorageProvider), §8 (Catalog, Inventory), §9, §11.

Build:
1. Products: title, handle, rich description (TipTap in admin, DOMPurify on output), status
   (draft/active/archived), vendor, product type, tags, SEO title/description, metafields,
   up to 3 options and their values, variants (price, compare-at price, cost, SKU, barcode,
   weight, requires shipping, taxable, HSN code), variant images.
2. Inventory: inventory items per variant, multiple locations, levels (available,
   committed, incoming), adjustment ledger with reason, "track quantity" and
   "continue selling when out of stock" flags.
3. Collections: manual (ordered) and smart (rules on tag, title, type, vendor, price,
   inventory, with all/any match), sort orders like Shopify, collection image + SEO.
4. Media: upload through the configured StorageProvider (direct-to-storage signed upload
   when supported, else via API), worker generates WebP/AVIF size variants with sharp,
   alt text, reorder, /media proxy for private buckets.
5. Remaining storage adapters: Cloudflare R2, Google Cloud Storage, Azure Blob,
   Backblaze B2, Google Drive. "Migrate media to new provider" job in Settings → Storage.
6. Admin: product list (search, filters, saved views, bulk edit/archive/tag), product editor
   with variant matrix, collection editor, inventory page per location, CSV import/export
   (must accept Shopify's product CSV format, background job with progress + error report).
7. Search: Postgres full-text + pg_trgm for admin and storefront; Meilisearch adapter
   behind an interface, enabled by the compose profile.
8. Storefront API: products, product by handle, collections, collection products with
   filters (price, availability, option values, tags), search; cursor pagination; cache
   headers. Outbox product.*/collection.* events → worker revalidates storefront cache tags.
9. Storefront: basic home, collection and product pages (Phase 5 replaces with theme system)
   to prove the data flow.

Done when:
- product with 2 options, 6 variants and 4 images created in admin appears on storefront
  within 5 seconds with no rebuild;
- a 500-product Shopify CSV imports cleanly and re-import is idempotent by handle;
- every storage adapter passes the same contract test suite (MinIO used for S3-compatible
  ones in CI; others behind env-gated live tests).
```
