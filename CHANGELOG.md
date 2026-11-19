# Changelog

All notable changes are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased] — Phase 3: cart, checkout, payments, orders, customers

### Added
- Schema: carts, cart lines, checkouts, orders (financial / fulfillment / status split, per-store numbering),
  order lines, order events, transactions, payment sessions, payment webhook events, refunds, draft orders,
  customers, addresses, tags, basic discount codes and usages, email delivery log.
- One pricing service for cart, checkout, orders and drafts (discount allocation, flat-rate shipping, GST
  CGST/SGST/IGST or generic tax, inclusive or exclusive prices).
- Payment adapters: Stripe (Payment Intents), PayPal (Orders v2), Cashfree, PhonePe (Standard Checkout v2),
  manual bank transfer; Razorpay wired to checkout. Shared payment contract suite with recorded fixtures.
- Checkout flow per SPEC §7: server-priced payment session, stock reserved with a delayed release, widget or
  redirect, verified return, webhook as source of truth (deduped by event id), offline methods place the order.
- Orders admin: list with filters, detail with timeline, staff comments, tags/notes, payments, mark as paid,
  refunds through the provider (with restock), cancel with restock/refund, shipping-update email. Draft orders
  and manual order creation. Customers list (lifetime value) and detail. Basic discount codes.
- Customer accounts: email code (default) or password, cart merge at sign-in, addresses, order history,
  marketing consent.
- Emails (React Email render, outbox → email queue, once per order + template): order confirmation, payment
  failed, cancelled, shipping update, refund, sign-in code, abandoned checkout; staff alerts for new and paid
  orders. Subjects and intros editable in Settings → Notifications; checkout settings page.
- Storefront: add to cart, cart page, one-page checkout, return page, thank-you/order status page by signed
  link, account pages.
- Worker: `inventory-release` delayed jobs and the `abandoned-cart` repeatable scan.
- e2e: `docker-compose.e2e.yml` (payment sandbox + Mailpit) and the checkout suite.

### Changed
- Email jobs are de-duplicated by an `email_deliveries` row instead of a Redis key.
- Stripe, PayPal, Cashfree, PhonePe and bank transfer are no longer "coming soon" in the setup wizard.

## Phase 2: catalog and media

### Added
- Catalog schema: products, options/values, variants (price, compare-at, cost, SKU, barcode, weight, shipping,
  taxable, HSN), tags, vendors, product types, product media, collections (manual/smart) with materialised
  membership, metafield definitions/values, saved views, inventory items/levels/adjustment ledger, `jobs_log`.
- `packages/core`: product, collection, inventory, media, search, storefront and CSV services; DOMPurify
  sanitising on write and output; keyset cursor pagination; refreshed price range/availability/search vector.
- Storage adapters: Cloudflare R2, Backblaze B2, Google Cloud Storage, Azure Blob, Google Drive; streaming
  multipart uploads for the S3 family; presigned direct uploads; one contract test suite for every adapter
  (emulators in CI, `SHOPKIT_LIVE_STORAGE_<ID>` for real accounts).
- Media: API or direct-to-storage upload, sharp WebP/AVIF renditions in the worker, alt text, ordering,
  `/media/<id>/w<width>.<fmt>` renditions and signed `/media/s/...` URLs, migration to another provider.
- Admin API and admin UI: product list (search, filters, saved views, bulk edit/archive/tag/delete), product
  editor (TipTap, variant matrix, media with drag-and-drop, metafields, SEO), collections editor (rules builder,
  manual ordering), inventory per location with ledger history, Shopify CSV import/export with progress and
  error report, Settings → Storage media migration.
- Storefront API: products, product by handle, collections, collection products with price/availability/
  option/tag filters, facets, search, cursor pagination, cache headers. Storefront home, collection, product
  and search pages (replaced by themes in Phase 5).
- Worker: images, imports, media-migration and search-index queues; product/collection/media events revalidate
  storefront cache tags.
- Search: Postgres full-text + pg_trgm; optional Meilisearch (compose profile `meilisearch`, `search:reindex`).
- Playwright catalog suite.

### Changed
- `/internal/revalidate` expires tags immediately (`{ expire: 0 }`) so catalog changes show on the next visit.
- Signed local media URLs include the provider id; the setup wizard updates the default location in place.
- Upload limit for product images and CSV files is 20 MB (brand assets stay at 5 MB).

## Phase 1: foundation + setup wizard

### Added
- pnpm + Turborepo monorepo: `apps/{api,worker,admin,storefront}`, `packages/{db,core,crypto,providers,sdk,ui,config}`, `e2e`.
- `packages/crypto`: envelope AES-256-GCM (per-secret DEK, AAD `store|kind|provider|mode`), versioned master keyring, 100% unit coverage.
- `packages/db`: Drizzle schema + migrations for stores, settings, setup_state, domains, staff_users, roles, role_permissions, api_keys, audit_logs, provider_credentials, outbox_events, media, locations; UUIDv7.
- Auth: argon2id, Redis sessions (8 h idle) in httpOnly cookies, TOTP 2FA, RBAC (owner/admin/staff), per-IP login rate limit, lockout after 5 failures for 15 minutes, CSRF.
- Setup API + `/admin/setup` wizard (steps 0–8) with one-time setup token, server-side step persistence, "Test connection", settings forms generated from provider zod schemas, write-only secrets (last4 only).
- Providers: storage Local + S3/S3-compatible; payments Razorpay + Cash on Delivery; email SMTP + Resend; analytics GA4 + Plausible. Other SPEC providers shown as "coming soon".
- Worker: outbox dispatcher (`FOR UPDATE SKIP LOCKED`), email queue, image queue stub, storefront revalidation queue.
- Admin shell (Home, Orders, Products, Customers, Content, Analytics, Settings), settings pages for every wizard section, staff 2FA, audit log.
- Storefront "coming soon" page and store home (name, logo, brand colour).
- CLI: `pnpm shopkit db:migrate | keys:verify | keys:rotate --to <v> | setup:token`.
- OpenAPI 3.1 at `/api/docs`; typed SDK generated from it (`pnpm sdk:check` fails when stale).
- Docker: non-root multi-stage images, `docker-compose.yml` (postgres, redis, migrate, api, worker, admin, storefront, caddy, `minio` profile), `docker-compose.dev.yml` with hot reload, `scripts/install.sh`.
- Playwright e2e for the whole wizard against the compose stack.
