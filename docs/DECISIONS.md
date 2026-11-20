# Decisions

Changes to, or interpretations of, `docs/SPEC.md`. Newest last. Each entry says what changed and why.

## Phase 1 (foundation + setup wizard)

**D-001 · Store row is created when setup starts, not at launch (SPEC §5 step 8).**
`provider_credentials` and `staff_users` need a `store_id` (foreign key, and part of the encryption AAD) before
launch: the owner is created in step 1 and storage credentials in step 2. The store is inserted with
`status = 'setup'` when a valid setup token is first presented; "Launch store" flips it to `active`,
records `launched_at`, deletes the setup tokens and signs the owner in. Behaviour seen by the merchant is
unchanged.

**D-002 · Provider adapters are factories.**
SPEC §7 lists instance methods (`createSession`, `put`, `send`…). Each provider exports a
`ProviderDefinition` (id, kind, display name, modes, `configSchema`, `secretsSchema`, `last4Field`,
`webhookEvents`) plus `create(ctx)` which binds decrypted config/secrets and returns an object with exactly
the SPEC §7 methods. This keeps secrets out of method arguments and lets the registry describe providers
without instantiating them.

**D-003 · RustFS replaces MinIO as the bundled S3-compatible store.**
MinIO no longer publishes community container images (Docker Hub repository removed; quay.io requires
auth). The compose profile is still called `minio` (alias `s3`) and the service is still reachable as
`minio:9000`, but it runs `rustfs/rustfs` (Apache-2.0, S3 API compatible). The adapter is the generic
"MinIO / S3-compatible" provider, so any S3 API works.

**D-004 · `StorageProvider.get(key)` added.**
SPEC §7 says `publicUrl()` returns null when files must be served through the `/media` proxy, but the
interface had no read method. `get(key)` streams the object for that proxy.

**D-005 · Shipping & tax setup is stored in `settings` until Phase 4.**
Wizard step 7 writes `shipping.defaults` and `tax.config` (typed settings) and a default `locations` row
(ship-from). Phase 4 introduces `shipping_zones`, `shipping_rates` and `tax_rates` and migrates these values.

**D-006 · TypeScript 6.0, not 7.**
`typescript-eslint` supports `typescript < 6.1`; TS 7 (native) would break type-aware linting.

**D-007 · Setup tokens.**
Each API replica issues its own token at boot while setup is required (hash added to a Redis set, 7-day
TTL) and prints it to stdout (not through pino, so redaction cannot hide it). Any issued token is valid.
`pnpm shopkit setup:token` issues another. All are deleted at launch.

**D-008 · CSRF.**
Staff sessions use a synchronizer token stored in the Redis session and exposed in a readable `sk_csrf`
cookie; writes must echo it in `X-CSRF-Token`. During setup the token travels in an httpOnly,
SameSite=Strict cookie scoped to `/api/setup`; its CSRF value is `HMAC(SESSION_SECRET, token)`, so no
extra state is stored. API clients may send `X-Setup-Token` instead (no cookie, no CSRF needed). Auth
guards run in `onRequest`, before body validation, so unauthenticated calls never learn about schemas.

**D-009 · Phase-1 emails are plain template functions.**
Only "test" and "store is live" emails exist; React Email arrives with order emails in Phase 3.

**D-010 · Payment webhook ingress is Phase 3.**
`POST /api/webhooks/payments/:provider` needs `payment_webhook_events` and orders. Razorpay's
`parseWebhook` (raw-body HMAC, event-id) is implemented and tested now, and the wizard already shows the
webhook URL to paste into the provider dashboard.

**D-011 · Settings forms come from JSON Schema served by the API.**
The API serves each provider's `z.toJSONSchema()` output; the admin renders forms from it. The admin
never imports provider code (it only talks to the API through `packages/sdk`, SPEC §3).

**D-012 · Docker builds work with the classic builder.**
No BuildKit-only syntax (`RUN --mount`), so `docker compose up --build` works on hosts without buildx.
Node services ship via `pnpm deploy --prod`; Next.js apps use `output: "standalone"`. Images are built
locally until GHCR publishing (Phase 6); `install.sh` tries `pull` first and builds what it cannot pull.

**D-013 · Lint stack.**
ESLint 10 + typescript-eslint (type-aware). The Next.js and react-hooks ESLint plugins were not on the
approved dependency list, so they are not used yet.

**D-014 · Storefront revalidation endpoint is `/internal/revalidate`.**
`/api/*` belongs to the API behind Caddy, so the storefront's shared-secret endpoint lives at
`/internal/revalidate`; Caddy answers 404 for `/internal/*` publicly. The worker calls it on
`store.launched`, `store.updated` and `media.created`.

**D-015 · Deferred within Phase 1.**
- `api_keys` table exists; API-key authentication arrives with the public API (Phase 6).
- Signed URLs for private local media are implemented in the adapter; no private media route yet.
- Uploads are sniffed and size-limited; `sharp` re-encoding runs in the image queue from Phase 2 (stub now).
- Settings pages for Domains, API & Webhooks, Backups and Jobs arrive with those features.
- Staff invitations (beyond the owner) arrive in Phase 4; RBAC roles are seeded now.

## Phase 2 (catalog and media)

**D-016 · `StorageProvider.createUploadUrl()` (optional) for direct-to-storage uploads.**
The admin asks `POST /api/admin/media/uploads`; when the active provider can presign a PUT (S3, MinIO/RustFS,
R2, B2, GCS, Azure) the browser uploads straight to the bucket and then calls `/media/:id/complete`, where the
API re-reads the object, enforces the 20 MB limit and sniffs the real type before marking it ready. Buckets need a
CORS rule allowing `PUT` from the shop's origin; if the PUT fails (CORS, network) the admin falls back to the API
upload. Local disk and Google Drive always upload through the API.

**D-017 · Signed proxy URLs carry the provider id.** `/media/s/<store>/<provider>/<key>?exp&sig` (HMAC over all
four parts) is now served by the API (closes the D-015 item). Local disk and Google Drive use it for
`getSignedUrl`; other providers return native signed URLs.

**D-018 · Media layout and renditions.** Originals are stored at `media/<id>/original.<ext>`; the images queue
writes WebP and AVIF renditions at `media/<id>/w<width>.<webp|avif>` for widths 160/320/640/1024/1600/2048 (never
upscaled, EXIF-rotated, metadata stripped). Views always point at `/media/<id>/<file>` on the shop's origin: the
proxy streams private objects and 302-redirects to the provider's public URL when one is configured, so read
models never load providers. Originals are kept (re-processing, exports).

**D-019 · Variants store option values Shopify-style.** `product_variants.option1..3` hold the values (unique per
product, `NULLS NOT DISTINCT`), while `product_options` / `product_option_values` keep names and display order.
Saving a product replaces options and matches existing variants by id, then by option combination, so variant
ids and their inventory survive edits. Up to 3 options and 2,048 variants per product.

**D-020 · Denormalised product columns and materialised smart collections.** `products.price_min/price_max/
compare_at_price_max/available/total_inventory/search_vector` are recomputed by `refreshProducts()` in the same
transaction as every product, variant, tag or inventory write. Smart-collection membership is materialised in
`collection_products` (re-evaluated for the changed products on product writes, rebuilt on rule changes), so
storefront listings, filters and sorts are single-table queries with keyset pagination. Rule money values are
integer minor units.

**D-021 · Inventory policy lives on the variant, "track quantity" on the inventory item** (Shopify's model).
Adjustments lock the level row (`FOR UPDATE`) and append one `inventory_adjustments` row per quantity changed;
a "set" to the current value writes nothing. Quantities set from the product editor or a CSV without a location
go to the default location, created on demand when setup step 7 was skipped. The wizard now updates the default
location in place (deleting it would cascade-delete stock levels).

**D-022 · "Best selling" sorts newest-first until orders exist (Phase 3).**

**D-023 · Tables and columns beyond SPEC §8.** `saved_views` (product list views); `media.status/renditions/
processed_at/processing_error/source_url`; `jobs_log` (from SPEC's platform list) records CSV imports/exports and
media migrations with progress and up to 1,000 errors.

**D-024 · Search.** Admin search always uses Postgres: a weighted `tsvector` (`simple` configuration, so it is
language-agnostic; title A, vendor/type/tags/SKUs/options B, description C) with prefix matching or a title substring; when nothing matches exactly, `pg_trgm`
similarity on the title catches typos (decided once per query so cursors stay stable). The storefront uses the `SearchEngine` interface: Postgres by default,
Meilisearch when `MEILISEARCH_URL` is set (compose profile `meilisearch`; the master key is infrastructure config
generated by install.sh, not a merchant secret). The `search-index` queue keeps Meilisearch in sync from product
events; `shopkit search:reindex` rebuilds it.

**D-025 · Storefront cache tags and immediate expiry.** Storefront fetches use `cache: "force-cache"` with tags
`store`, `products`, `collections`, `product-handle:<h>`, `collection-handle:<h>`; product/collection/media events
revalidate those plus `product:<id>`/`collection:<id>` (SPEC §4). `/internal/revalidate` now calls
`revalidateTag(tag, { expire: 0 })` instead of `"max"`: the next visit renders fresh data, which is what the
"visible within 5 seconds" target needs, at the cost of one blocking render per change.

**D-026 · The storefront's SSR traffic bypasses the per-IP rate limit** by sending `x-shopkit-internal:
<REVALIDATE_SECRET>` (all shoppers reach the API from the storefront container's single IP). The api service now
receives `REVALIDATE_SECRET`.

**D-027 · Rich text is sanitised on write and on output** with DOMPurify (server-side via jsdom, lazily loaded,
results memoised), using the PLS allow-list plus tables/images (https or relative only). The storefront renders
the API's sanitised HTML.

**D-028 · Shopify CSV import.** Rows are grouped by Handle; each product is upserted by handle in its own
transaction, so a bad row is reported (line, handle, message) without stopping the job and a re-import updates
in place (variants matched by options, images de-duplicated by source URL, quantities "set" so unchanged values
add no ledger rows). Image URLs are downloaded with an SSRF guard (http(s) only, no credentials, every resolved
address public, ≤3 redirects re-checked, ≤20 MB, content sniffed); DNS rebinding between check and connect is not
prevented. Ignored columns: markets ("Price / India"…), Google Shopping, metafield columns, "Product Category".
Shopkit adds an optional `Variant HSN Code` column (Shopify ignores unknown columns). Export writes the same
format, with `Image Src` pointing at the original source URL or the shop's `/media` URL.

**D-029 · Media migration copies, repoints, then switches.** Settings → Storage → "Migrate media" copies every
original and rendition to the target provider, updates `media.storage_provider` row by row (re-runs skip moved
rows) and makes the target active only when nothing failed. Objects on the old provider are not deleted.

**D-030 · Storage contract tests.** One suite (`packages/providers/test/storage-contract.ts`) runs against local
disk, RustFS (S3-compatible, AWS S3, R2 and B2 adapters via a custom endpoint), fake-gcs-server (Google's OAuth
token endpoint is mocked; the emulator only serves path-style downloads for its own public host, so GCS signed
URLs are checked structurally there), Azurite, and an in-process Google Drive fake. The same suite runs against
real accounts when `SHOPKIT_LIVE_STORAGE_<ID>` holds `{"config":…,"secrets":…}`.

**D-031 · Google Drive storage** keeps every object as a file named after its key inside one folder shared with a
service account (`drive` scope), is always served through the signed `/media` proxy and has no direct uploads.
GCS and Drive take the service-account key file as a write-only secret.

**D-032 · Deferred within Phase 2.**
- Best-selling sort (needs orders, Phase 3); Redis hot-read cache for storefront reads (SPEC §4; Next's tagged data
  cache covers it for now).
- Browser-side image resize before upload (PLS `image-upload.ts`); clean-up of abandoned pending direct uploads.
- Metafields on the Storefront API (admin only for now) and metafield CSV columns.
- Deleting objects from the old provider after a media migration.
- A Meilisearch service in `docker-compose.dev.yml` (use the production profile or point `MEILISEARCH_URL` at one).

## Phase 3 — cart, checkout, payments, orders, customers

**D-033 · One pricing function.** `packages/core/src/commerce/pricing.ts` (`priceLines`) prices carts,
checkouts, order creation and draft orders. It reads variants, stock, the discount code, `shipping.defaults` and
`tax.config` from the database; the browser only sends variant ids, quantities and choices. Order discounts are
allocated to lines (largest remainder) before tax; tax is per line, rounded half away from zero; GST splits into
CGST+SGST when the shipping state equals `registeredState`, else IGST. Tax on shipping is opt-in
(`tax.config.taxShipping`). Shipping uses the single flat rate from setup until Phase 4 adds zones.

**D-034 · Orders exist before payment, numbers do not.** The payment-session call creates the order row
(`placed_at` null, no number) so providers can reference it (SPEC §7 step 1), and reserves stock: Shopify
semantics, `available −q, committed +q`, once. The order gets its number (`order_sequences`, prefix from
`checkout.config.orderPrefix`) only when placed — paid online, or confirmed for COD/bank transfer — so unpaid
attempts never burn numbers. An unplaced order whose reservation expired is an abandoned checkout, not an order.
A payment that arrives after the reservation was released re-reserves (it may oversell) and is flagged in the
timeline. Payments that do not match the total are recorded and flagged (`payment_mismatch`), never treated as
full payment.

**D-035 · Payment idempotency.** Webhooks: signature on the raw body, then the provider event id is inserted into
`payment_webhook_events` in the same transaction that applies it; a duplicate insert is a no-op. Transactions are
unique per (store, provider, kind, provider payment/refund id), so a browser return and a webhook for the same
payment record it once. Cashfree and PhonePe send no event id; the adapter builds one from the object id and its
new state. Refunds pass our refund id as the provider idempotency key where supported.

**D-036 · Extra tables.** `payment_sessions` (every provider session per order, so late webhooks for an earlier
session still find the order), `order_sequences`, `email_deliveries` (one row per idempotency key, claimed before
sending — the email job sends each order+template once even when retried; replaces Phase 1's Redis marker) and
`draft_orders`. Abandoned checkouts are `checkouts.abandoned_notified_at`, not a separate table. Customer
sessions live in Redis like staff sessions; there is no `customer_sessions` table.

**D-037 · Provider interface additions.** `ProviderDefinition.paymentFlow` (`widget` | `redirect` | `offline`)
tells checkout how to open a method; `PaymentProvider.refund` takes an optional idempotency key;
`ProviderRuntime.paymentSandbox` lets test-mode adapters call a local sandbox (e2e only; live mode ignores it).
Stripe, PayPal, Cashfree and PhonePe are implemented over `fetch` (no SDKs), like Razorpay. PayPal webhooks are
verified with PayPal's `verify-webhook-signature` API (needs the webhook id in config). PhonePe returns without
parameters, so its return is verified by a server-to-server status lookup of the stored merchant order id.
Cashfree needs a 10-digit phone number.

**D-038 · Storefront CSRF by custom header.** Cart, checkout and account endpoints are cookie-authenticated;
every mutating request must send `X-Shopkit-Client: storefront`, which a cross-site form cannot send without a
CORS preflight (the API grants none). Staff routes keep their CSRF token.

**D-039 · Customer accounts.** Email one-time codes (6 digits, 10 minutes, 5 attempts, 5 sends per address per
hour) are the default and create the account on first sign-in; `checkout.config.customerAuth = "password"` adds
password sign-in/registration (codes still work). Every placed order is linked to a customer record (created for
guests, like Shopify) so lifetime value and order history work; marketing consent is only ever switched on by a
checkout. Carts merge at sign-in (quantities add up). The OTP code travels in the outbox payload to the email job.

**D-040 · Emails.** React Email's component package is deprecated, so templates are plain JSX (tables, inline
styles) rendered with `@react-email/render`. Merchants can edit subject and intro and switch off any template
except the sign-in code (Settings → Notifications). Abandoned-checkout reminders come from a repeatable scan
(`abandoned-cart` queue, every minute) that marks and enqueues in one transaction, rather than a delayed job per
checkout, so changing the delay applies to open checkouts too. The same scan sweeps expired reservations in case
a delayed `inventory-release` job was lost.

**D-041 · Payment e2e uses a local sandbox.** `docker-compose.e2e.yml` adds `payments-sandbox` (a dependency-free
Node server that mimics the Razorpay and Stripe endpoints Shopkit calls, their browser scripts, and signed
webhooks) and Mailpit. With `PAYMENT_SANDBOX_URL` set, test-mode Razorpay/Stripe/PayPal/Cashfree/PhonePe calls go
there. This proves our flow (server pricing, widget/redirect, verify, webhook, idempotency) offline; it does not
prove compatibility with the real providers' current APIs, which the recorded-fixture contract tests and a manual
check with real test keys cover.

**D-042 · Deferred within Phase 3.**
- Fulfillments, shipping zones/carriers, returns, the full discount engine, tax overrides (Phase 4). "Shipping
  update" is a staff action that records a timeline event and emails tracking details.
- Gift cards, free (zero-total) orders, multi-currency, order editing after placement.
- PayPal capture on `CHECKOUT.ORDER.APPROVED` webhooks (the return captures; a shopper who closes the tab after
  approving leaves an uncaptured PayPal order).
- Password reset emails for password accounts (sign in with a code instead).
- A real-provider e2e spec (needs public webhook URLs); run the flow manually with test keys.

## Phase 4 — merchant operations

**D-043 · Discount engine is pure and Shopify-shaped.** `commerce/discount-engine.ts` takes priced lines, the
shipping charge and candidate discounts (status, schedule, eligibility and usage limits already filtered by
`discounts.ts`) and returns the best allowed combination with every amount allocated to lines. Classes follow
Shopify: product (product/collection targets, buy X get Y), order and shipping; two discounts combine only when
each allows the other's class. Product discounts apply first, order discounts on what remains, shipping last.
Automatic discounts are discounts without a code. Usage is recorded per order and customer in the order
transaction. Table-driven tests cover every kind and combination rule.

**D-044 · Shipping zones.** A zone lists countries, optionally narrowed to states and PIN/postal prefixes; the most
specific zone for the address wins (prefix > state > country > `*`). Rates: flat, by weight, by order value,
carrier-calculated (live quote from the shipping adapter), local pickup at a location and local delivery by PIN
prefix; any rate can be free over an amount. A store with no zones keeps the Phase 1 flat rate
(`shipping.defaults`), so existing installs behave the same until they add zones.

**D-045 · Fulfillments.** Partial and multi-location; each fulfillment records its lines, location and method
(PLS methods: local driver with name/mobile/trip link, courier with AWB and an automatic tracking link for known
couriers, other courier; plus carrier-booked shipments, pickup and none). Fulfilling moves stock from `committed`
out of the location; cancelling a fulfillment reserves it again. "Send on WhatsApp" builds a `wa.me` link with
the PLS message and records that it was used; staff press Send in WhatsApp (no WhatsApp API). Box labels (A6 and
A4) are printed in the browser from the order view, as in PLS. Carrier tracking webhooks
(`/api/webhooks/shipping/:provider`) are verified by the adapter, deduped by event id in
`shipping_webhook_events`, and only move a fulfillment forward.

**D-046 · Refunds and returns.** Refunds go through `PaymentProvider.refund` with our refund id as idempotency key;
a refund the provider reports as pending counts only once confirmed (webhook or status), so `amount_refunded`
always equals successful refund transactions. Gift-card-paid parts go back onto the cards. Returns: requested by
the shopper (status page by signed link, or account) or created by staff → approved/declined → received
(optionally restocked at a location) → closed with a refund, an exchange (a draft order credited with the
returned value) or nothing. Fulfillment status becomes `returned` when every shipped unit came back.

**D-047 · Invoices without a PDF library.** GST invoices are rendered by a ~130-line PDF 1.4 writer
(`packages/core/src/pdf.ts`, Helvetica/WinAnsi, no embedded fonts) instead of adding pdfkit or a headless browser:
invoices only need text and rules. The first request issues the number from a per-store sequence and freezes the
data, so reprints never change. Totals come from the stored per-line tax split, so they equal the line taxes
(CGST+SGST intra-state, IGST inter-state, HSN, GSTINs, place of supply, amount in Indian words).

**D-048 · Gift cards.** Codes are shown once and stored as SHA-256 plus the last 4 characters; balances are a
row-locked running total with a ledger row per change. Cards are debited when the order is created for payment
and credited back if that order is re-priced, abandoned or refunded. A gift card product issues one card per unit
when paid. An order fully covered by gift cards is placed with the internal `gift_card` method (no provider). The
checkout view returns the codes the shopper entered (their own cart, `no-store`) so the page can remove one.

**D-049 · Reports from orders, funnel from `analytics_daily`.** Sales figures use Shopify's definitions (gross →
net → total) computed from placed orders in the store timezone; the conversion funnel reads `analytics_daily`,
whose add-to-cart/checkout/order columns the worker recomputes for today and yesterday every 15 minutes
(`analytics` queue, `ANALYTICS_ROLLUP_INTERVAL_MS`). Sessions and page views stay 0 until the Phase 5 storefront
tracker writes them. CSV exports neutralise spreadsheet formulas.

**D-050 · Staff.** Custom roles are permission sets from the fixed list in `auth/permissions.ts` (new in this
phase: `orders:fulfill`, `orders:returns`, `discounts:*`, `gift_cards:*`, `reports:read`, `settings:tax`,
`settings:security`); the owner role cannot be edited or assigned. Invitations are single-use hashed tokens valid
7 days, emailed through the outbox; accepting creates the account with a strength-checked password. When the owner
requires 2FA (they must have it on themselves first), every admin route answers 403
`two_factor_required` for staff without it except `/me`, TOTP enrolment and sign-out, and the admin shows the
enrolment screen. Changing someone's role or disabling them ends their sessions.

**D-051 · Deferred within Phase 4.**
- Polling carrier tracking for carriers without webhooks (status changes come from webhooks or staff).
- Live carrier rate quotes in the fulfil dialog (the carrier books with its default service; checkout already
  quotes live rates for carrier-calculated zones).
- Selling gift cards to a different recipient from the storefront product page (the `Recipient email` line
  attribute works through the API).
- Order editing after placement and multi-currency (as in D-042).

## Phase 5 — storefront, themes, CMS, SEO, analytics

**D-052 · Theme data model.** SPEC §8 names `themes`, `theme_templates` and `theme_settings`; each template and
the global settings row hold a `draft` and a `published` JSON column, and a fourth table, `theme_versions`,
snapshots every template + settings at each publish. Publishing copies drafts to live in one transaction, bumps
`themes.published_version` and writes an outbox `theme.published` event that revalidates the storefront's `theme`
cache tag — no rebuild or restart. Rollback republishes an old snapshot as a new version, so history is never
rewritten. The editor autosaves drafts; the live shop changes only on Publish.

**D-053 · Theme packages.** `packages/theme-sdk` (framework-free: setting types, template JSON zod schema,
`readSettings`, `normalizeTemplate`, `resolveTemplate`) and `packages/themes/default` (schema module without React
for the API/admin, server section components, two client components) are built to `dist` like `@shopkit/ui`, so the
API (NodeNext) can import `@shopkit/theme-default/schema` to validate drafts. Sections get data through a
`ThemeData` interface the storefront implements; the theme never calls the API. Every non-layout template has one
`main-*` section that renders the page's own content (product form, cart, account), keeping commerce logic in the
storefront. The announcement bar, header and footer are sections of a `layout` template (header and footer groups).

**D-054 · Fonts are system stacks.** The `font` setting chooses among six system font stacks (sans, humanist,
geometric, two serifs, mono). Web fonts would cost a render-blocking request per visit (Lighthouse mobile ≥ 90)
and a third-party request before consent. Self-hosted font files can be added later as another option.

**D-055 · Branding feeds theme settings.** The theme's accent colour and logo fall back to the store brand set
in setup (Settings → Branding) until the merchant sets them in the theme editor. Button text colour is chosen
for contrast (black or white), and link/sale colours fall back to the text colour when they would fail WCAG AA
on the background, so any brand colour stays accessible.

**D-056 · Preview by signed cookie.** The editor gets a signed, 2-hour preview token from the API; the iframe
opens `/preview?token…`, which verifies it and stores it in an httpOnly cookie. Theme reads for that browser then
ask the API for the draft, uncached (the API re-verifies the token); other visitors keep the cached live theme.
Next's Draft Mode was tried first, but its bypass cookie was not kept through the redirect from a route handler
behind the proxy, so refreshes lost the draft; every storefront page renders per request anyway, so the cookie is
enough. The editor posts `sk:refresh` / `sk:select` messages to the same-origin iframe.

**D-057 · CMS and redirects.** Pages, policy pages (`kind = 'policy'`, one per type, generated from templates
filled with the store's details — marked as a starting point, not legal advice), blogs and articles; HTML is
sanitised with the Phase 2 DOMPurify allow-list on write and on output. Menus nest three levels; items reference
resources by id so renames never break links, and links to unpublished/deleted resources are dropped. Changing a
product, collection, page, blog or article handle inserts an automatic redirect and re-points older redirects (no
chains); changing it back removes the redirect. The storefront follows redirects (308) for missing resources and
in a catch-all route.

**D-058 · SEO.** Per-page title/description/canonical/Open Graph/Twitter metadata (ported from PLS `seo.ts`);
one JSON-LD `@graph` per page: Organization + WebSite with SearchAction (home), Product with an Offer per variant
or AggregateOffer + BreadcrumbList (product), CollectionPage + BreadcrumbList, BlogPosting. `productLd` takes an
optional rating so AggregateRating appears once reviews exist (Google rejects invented ratings). Sitemap index at
`/sitemap.xml` with per-type sitemaps (`/sitemaps/<type>-<n>.xml`, 5,000 URLs each); filtered/sorted collection
URLs are `noindex` and canonicalise to the plain URL. A default Open Graph image is generated with `next/og`.

**D-059 · Analytics and consent.** The storefront renders each enabled provider's `clientSnippet` client-side:
snippets that `requiresConsent` are injected only after "Accept" (stored in `localStorage`); with the banner turned
off, consent-requiring providers are not rendered at all. Umami, Plausible and cookieless Matomo need no consent.
Ecommerce events (`view_item`, `add_to_cart`, `begin_checkout`, `purchase`) go to whichever trackers are loaded and
to the first-party collector (`POST /api/storefront/events`: no cookies, no IP stored, a random per-tab session
id), which the worker rolls into `analytics_daily` sessions/page views and prunes after 90 days. The worker sends
server-side purchase/refund events, one job per provider so a failing provider retries alone; Meta's Conversions
API receives only a SHA-256 of the buyer email. New adapters: Umami, Matomo, PostHog, Meta Pixel.

**D-060 · Deferred within Phase 5.**
- A Content-Security-Policy with nonces on the storefront (SPEC §10): analytics snippets are inline scripts; the
  nonce plumbing through Next and the providers is a Phase 6 hardening item.
- Product reviews (AggregateRating stays empty until a review source exists); per-product Open Graph images
  generated with `next/og` (product photos are used instead).
- Multiple installed themes / theme upload; section groups beyond header and footer; per-template alternates
  (`templateSuffix` is stored on pages but not yet selectable).
- Self-hosted web fonts (D-054).
