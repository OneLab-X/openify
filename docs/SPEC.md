# Shopkit — Master Specification

Shopkit is an open-source, self-hosted alternative to Shopify. A merchant installs it with Docker, opens the URL, and a setup wizard walks them through store details, branding and every third-party provider (storage, payments, email, analytics). Provider secrets are stored encrypted in PostgreSQL. The feature target is Shopify parity, delivered in phases (see `docs/prompts/`).

"Shopkit" is a working name. Rename freely.

This document is the source of truth. Any change to a decision here must be recorded in `docs/DECISIONS.md` with the reason.

---

## 1. Principles

1. **One `docker compose up` to a working shop.** No external SaaS required to boot (local storage, SMTP optional, COD payments work out of the box).
2. **Bring your own providers.** Every integration sits behind an adapter interface. Merchants choose providers in the UI, not in env vars.
3. **Secrets never leave the server in plaintext.** Encrypted at rest, write-only through the API.
4. **Single store per install, multi-store ready.** Every tenant-owned table has `store_id`. Multi-store is a later feature flag, not a rewrite.
5. **Stateless services, scale horizontally.** State lives in Postgres, Redis and object storage only.
6. **Server is the authority on money.** Prices, taxes, discounts and totals are computed server-side; payment webhooks are the source of truth for payment state.
7. **Side effects through the outbox.** Emails, webhooks, analytics, cache revalidation and search indexing are triggered by events written in the same transaction as the data change.

---

## 2. Tech stack

| Concern | Choice |
|---|---|
| Monorepo | pnpm workspaces + Turborepo |
| Language | TypeScript (strict), Node 22 LTS |
| API | Fastify 5, zod schemas → OpenAPI 3.1 (`fastify-type-provider-zod`) |
| ORM / migrations | Drizzle ORM + drizzle-kit |
| Database | PostgreSQL 17 (`pg_trgm`, `citext`, full-text search) |
| Cache / queues | Redis 7 + BullMQ |
| Admin & storefront | Next.js (App Router), React 19, Tailwind 4, shadcn/ui |
| Rich text | TipTap (editor), DOMPurify (sanitise on output) |
| Emails | React Email templates |
| Images | `sharp` in the worker |
| Auth | argon2id passwords, Redis-backed sessions, TOTP 2FA |
| Testing | Vitest, testcontainers (Postgres/Redis), Playwright e2e |
| Reverse proxy | Caddy (automatic HTTPS) |
| Optional | MinIO (local S3), Meilisearch (search), PgBouncer |
| Observability | pino, OpenTelemetry, Prometheus metrics |

> Next.js note: the version installed may be newer than an AI model's training data. Read `node_modules/next/dist/docs/` before writing Next.js code and follow its deprecation notices.

---

## 3. Repository layout

```
shopkit/
  apps/
    api/          Fastify: Admin API, Storefront API, Setup API, webhooks in
    worker/       BullMQ consumers: outbox dispatcher, webhooks out, email, images,
                  analytics, abandoned carts, backups, scheduled jobs
    admin/        Next.js: /setup wizard + merchant admin
    storefront/   Next.js: themeable shop, cart, checkout, customer accounts
  packages/
    db/           Drizzle schema, migrations, seed, test factories
    core/         domain services (catalog, inventory, cart, checkout, pricing,
                  orders, fulfillment, refunds, discounts, tax, customers)
    crypto/       envelope encryption, key rotation
    providers/    adapter interfaces + implementations, provider registry
      payments/ storage/ email/ analytics/ shipping/
    sdk/          typed API client generated from OpenAPI
    ui/           shared components (shadcn, Tailwind 4)
    theme-sdk/    section/block/setting schema types for themes
    themes/default/  default storefront theme
    config/       tsconfig, eslint, vitest, prettier presets
  docker/
    api.Dockerfile worker.Dockerfile admin.Dockerfile storefront.Dockerfile
    Caddyfile
  docker-compose.yml
  docker-compose.dev.yml
  scripts/install.sh
  docs/
```

Dependency direction: `apps/*` → `packages/core` → `packages/db`, `packages/providers`, `packages/crypto`. `core` never imports from `apps`. React apps talk to the API only through `packages/sdk`.

---

## 4. Runtime topology

```
           ┌──────────── Caddy (TLS, :443) ────────────┐
           │  /           → storefront:3000             │
           │  /admin      → admin:3001                  │
           │  /api        → api:4000                    │
           │  /media      → api (signed/public media)   │
           └────────────────────────────────────────────┘
 storefront ─┐            ┌─ worker (N replicas)
 admin ──────┼─► api (N) ─┤
             │            └─ Redis (queues, cache, sessions, rate limits)
             └──────────────► Postgres (via PgBouncer optional)
                              Object storage (MinIO / S3 / R2 / GCS / ...)
```

Docker compose services: `postgres`, `redis`, `migrate` (one-shot, runs drizzle migrations, `api` depends on it completing), `api`, `worker`, `admin`, `storefront`, `caddy`, and profiles `minio`, `meilisearch`.

Scaling:
- `api`, `admin`, `storefront`, `worker` are stateless; scale with `--scale` or Kubernetes replicas.
- Storefront pages use Next cache tags (`product:<id>`, `collection:<id>`, `theme`). The worker calls the storefront's revalidate endpoint (shared secret) when an outbox event changes catalog data.
- Hot reads (storefront product/collection) cached in Redis with tag invalidation.
- Read replicas: Drizzle supports a replica connection for read-only storefront queries (Phase 6).

---

## 5. Install and first boot

### `scripts/install.sh`
1. Checks Docker + Compose v2.
2. Asks for public domain (or `localhost`) and admin email for TLS.
3. Generates `.env`: `SHOPKIT_MASTER_KEY` (32 random bytes, base64), `POSTGRES_PASSWORD`, `SESSION_SECRET`, `REVALIDATE_SECRET`, `PUBLIC_URL`.
4. Prints a warning: **back up `.env`; losing `SHOPKIT_MASTER_KEY` makes stored provider secrets unrecoverable.**
5. `docker compose pull && docker compose up -d`, then prints the URL.

### Setup token
While no store exists, the API generates a one-time setup token, stores its hash in Redis, and prints it to the `api` container logs (`docker compose logs api`). Every `/setup/*` write endpoint requires it. This stops a stranger reaching the public URL first and claiming the install. The token is invalidated when setup completes.

### Setup wizard (`apps/admin` → `/setup`)
`GET /api/setup/status` returns `{ required: boolean, step: string }`. While required, admin middleware redirects every route to `/setup`, and the storefront shows a "coming soon" page.

Wizard state is persisted server-side per step, so a refresh resumes where the merchant left off.

| # | Step | Required | Contents |
|---|---|---|---|
| 0 | Setup token | yes | paste token from logs |
| 1 | Owner account | yes | name, email, password (zxcvbn ≥ 3), optional TOTP |
| 2 | Storage | yes (default preselected) | Local disk / MinIO (default), AWS S3, Cloudflare R2, Google Cloud Storage, Azure Blob, Backblaze B2, Google Drive. "Test connection" uploads and deletes a probe file |
| 3 | Store details | yes | store name, legal name, email, phone, address, country, currency, timezone, locale, weight unit, logo, favicon, brand colours, public URL |
| 4 | Payments | skippable | Razorpay, Stripe, PayPal, Cashfree, PhonePe, Cash on Delivery, manual bank transfer. Per provider: test/live mode, keys, webhook secret; shows the webhook URL to paste in the provider dashboard. "Test connection" calls a read-only provider API |
| 5 | Email | skippable | SMTP, Resend, Amazon SES, Postmark; from address, reply-to. "Send test email" |
| 6 | Analytics | skippable | GA4, Plausible, Umami, Matomo, PostHog, Meta Pixel; IDs / API secrets; cookie-consent banner on/off |
| 7 | Shipping & tax | skippable | ship-from location, default zone + flat rate, tax mode: India GST preset (prices tax-inclusive, CGST/SGST/IGST) or generic VAT/sales tax |
| 8 | Review & launch | yes | summary, "Launch store" → creates store, marks setup complete, deletes setup token, signs owner in |

Storage comes before store details so the logo uploads straight to the chosen provider.

Everything is editable later in **Admin → Settings** (General, Branding, Storage, Payments, Email, Analytics, Shipping, Taxes, Staff, Domains, API & Webhooks, Backups).

---

## 6. Secret encryption (`packages/crypto`)

- Master key: `SHOPKIT_MASTER_KEY` env var, 32 bytes. Supports a keyring `SHOPKIT_MASTER_KEY_<version>` for rotation; current version in `SHOPKIT_MASTER_KEY_VERSION`. Optional KMS adapter later (AWS KMS, GCP KMS, Vault) behind the same interface.
- Envelope encryption: for each secret, generate a random 32-byte DEK, encrypt the JSON secret payload with AES-256-GCM (random 12-byte IV, AAD = `store_id|kind|provider|mode`). Wrap the DEK with the master key (AES-256-GCM).
- Table `provider_credentials`:
  `id, store_id, kind (payment|storage|email|analytics|shipping), provider, mode (test|live), ciphertext, iv, auth_tag, wrapped_dek, dek_iv, dek_tag, key_version, last4, enabled, created_at, updated_at, rotated_at`
  Unique `(store_id, kind, provider, mode)`.
- Non-secret config (e.g. bucket name, region, public URL, GA measurement ID) goes in a plain `config jsonb` column on the same row so it can be shown in the UI.
- API rules: secrets are **write-only**. Responses return `{ configured: true, last4 }` only. Decryption happens only in api/worker memory, cached per process for ≤ 5 minutes, never logged (pino redaction paths configured).
- CLI: `pnpm shopkit keys:rotate --to <version>` re-wraps every DEK; `pnpm shopkit keys:verify` decrypts all rows to check the key.
- Every create/update/delete of a credential writes an `audit_logs` row (who, what, when, IP) without the secret.

---

## 7. Provider adapters (`packages/providers`)

All adapters are registered in a `ProviderRegistry` keyed by `kind` + `id`, each with a zod schema for its config and secrets (the admin renders the settings form from that schema). Community packages can register more.

```ts
interface ProviderBase<Config, Secrets> {
  id: string; kind: ProviderKind; displayName: string;
  configSchema: ZodType<Config>; secretsSchema: ZodType<Secrets>;
  testCredentials(ctx): Promise<{ ok: true } | { ok: false; error: string }>;
}

interface PaymentProvider extends ProviderBase {
  createSession(input: { order; amount; currency; customer; returnUrl }): Promise<PaymentSession>; // client payload for widget or redirect URL
  verifyReturn(payload): Promise<PaymentResult>;          // signature check on client return
  parseWebhook(rawBody: Buffer, headers): Promise<WebhookEvent>; // verify signature, normalise
  capture?(paymentId, amount): Promise<Transaction>;
  refund(paymentId, amount, reason?): Promise<Transaction>;
  getPayment(paymentId): Promise<PaymentResult>;
  webhookEvents: string[];                                 // shown in setup instructions
}

interface StorageProvider extends ProviderBase {
  put(key, body, { contentType, cacheControl }): Promise<void>;
  getSignedUrl(key, { expiresIn }): Promise<string>;
  publicUrl(key): string | null;   // null → serve through /media proxy
  delete(key): Promise<void>;
  list(prefix): AsyncIterable<string>;
}

interface EmailProvider extends ProviderBase {
  send(msg: { to; subject; html; text; replyTo?; idempotencyKey }): Promise<{ id: string }>;
}

interface AnalyticsProvider extends ProviderBase {
  clientSnippet(config): { head?: string; body?: string; requiresConsent: boolean };
  serverEvent?(event: 'purchase' | 'refund' | 'signup', payload): Promise<void>;
}

interface ShippingProvider extends ProviderBase {
  rates?(shipment): Promise<Rate[]>;
  createShipment?(fulfillment): Promise<{ awb; labelUrl; trackingUrl }>;
  track?(awb): Promise<TrackingStatus>;
}
```

Initial providers:
- **Payments:** Razorpay, Stripe, PayPal, Cashfree, PhonePe, Cash on Delivery, manual bank transfer.
- **Storage:** Local disk, MinIO/S3-compatible, AWS S3, Cloudflare R2, Google Cloud Storage, Azure Blob, Backblaze B2, Google Drive.
- **Email:** SMTP, Resend, Amazon SES, Postmark.
- **Analytics:** GA4, Plausible, Umami, Matomo, PostHog, Meta Pixel.
- **Shipping:** Manual (courier name/AWB/tracking URL, local driver details), Shiprocket, Delhivery, EasyPost.

### Payment flow (generalised from PLS)
1. Storefront calls `POST /storefront/checkouts/:id/payment-session`. Server recomputes totals from DB (never from browser), creates the order in `pending_payment`, reserves inventory, calls `createSession`, stores the provider order id.
2. Browser opens the provider widget / redirect.
3. On return, `POST /storefront/checkouts/:id/verify` → `verifyReturn` → marks `paid` if valid (fast path for UX).
4. `POST /webhooks/payments/:provider` is the source of truth: verify signature on the raw body, dedupe on provider event id (`payment_webhook_events` unique key), apply state transition idempotently (captured, failed, refunded), write outbox events.
5. Outbox → confirmation email (idempotency key = order id + template), merchant alert, analytics purchase event, outgoing webhooks.

---

## 8. Data model

Conventions: UUIDv7 primary keys; `store_id uuid not null` on every tenant table with a composite index leading on it; `created_at/updated_at timestamptz`; money as `bigint` minor units + `currency char(3)`; soft-delete via `archived_at` where Shopify archives; `citext` for emails; handles (slugs) unique per store.

Core tables:

- **Store & config:** `stores`, `settings` (typed key/value per store), `domains`, `provider_credentials`, `setup_state`
- **Staff & access:** `staff_users`, `roles`, `role_permissions`, `staff_sessions` (Redis, table for audit), `api_keys` (hashed, scoped), `audit_logs`
- **Catalog:** `products`, `product_options`, `product_option_values`, `product_variants`, `media`, `product_media`, `tags`, `product_tags`, `collections` (type manual|smart, `rules jsonb`), `collection_products`, `metafield_definitions`, `metafields`, `vendors`, `product_types`
- **Inventory:** `locations`, `inventory_items`, `inventory_levels` (available, committed, incoming per location), `inventory_adjustments` (ledger)
- **Customers:** `customers`, `customer_addresses`, `customer_sessions`, `customer_tags`
- **Commerce:** `carts`, `cart_lines`, `checkouts`, `orders`, `order_lines`, `order_events` (timeline), `transactions`, `payment_webhook_events`, `fulfillments`, `fulfillment_lines`, `refunds`, `refund_lines`, `returns`, `return_lines`, `abandoned_checkouts`
- **Pricing:** `discounts`, `discount_codes`, `discount_usages`, `gift_cards`, `gift_card_transactions`, `shipping_zones`, `shipping_zone_countries`, `shipping_rates`, `tax_rates`, `tax_overrides`
- **Content:** `pages`, `blogs`, `articles`, `menus`, `menu_items`, `redirects`, `themes`, `theme_templates`, `theme_settings`
- **Platform:** `outbox_events`, `webhook_subscriptions`, `webhook_deliveries`, `apps`, `app_installations`, `jobs_log`, `backups`
- **Analytics:** `analytics_daily` (sessions, views, add-to-carts, checkouts, orders, revenue per day), `search_queries`

Order state is split like Shopify: `financial_status` (pending, authorized, paid, partially_paid, partially_refunded, refunded, voided) and `fulfillment_status` (unfulfilled, partially_fulfilled, fulfilled, returned), plus `status` (open, closed, cancelled).

Order numbers: per-store sequence with configurable prefix (e.g. `PLS-1001`).

---

## 9. APIs

- **Setup API** `/api/setup/*` — wizard only, token-guarded.
- **Admin API** `/api/admin/*` — staff session cookie or scoped API key. Full CRUD for every resource. Cursor pagination, filtering, bulk operations.
- **Storefront API** `/api/storefront/*` — public, rate-limited, cacheable: products, collections, search, cart, checkout, customer account.
- **Webhooks in** `/api/webhooks/{payments|shipping}/:provider`.
- OpenAPI served at `/api/docs`. `packages/sdk` generated from it in CI; build fails if the SDK is stale.

---

## 10. Auth & security

- Staff: argon2id, Redis sessions in httpOnly SameSite=Lax secure cookies, 8-hour idle timeout, TOTP 2FA (enforceable by owner), login rate limit + lockout after 5 failures for 15 minutes, RBAC with permission strings (`products:write`, `orders:refund`, `settings:payments`…).
- Customers: email OTP (default) or password; separate session cookie scoped to storefront.
- CSRF tokens on cookie-authenticated mutating routes. CSP with nonces on storefront/admin. Strict input validation with zod. HTML from rich text sanitised with DOMPurify on output.
- Webhook signatures verified on raw body. Outgoing webhooks signed with HMAC-SHA256 per subscription.
- Uploaded files: content-type sniffing, size limits, image re-encoding.
- Secrets: see §6. Pino redaction for `authorization`, `cookie`, `*.secret`, `*.key`, `*.password`.

---

## 11. Storefront & themes

- A theme is a package exporting React section components plus JSON templates (`index`, `product`, `collection`, `cart`, `page`, `article`, `search`, `404`) that list sections and blocks with typed settings (`packages/theme-sdk`).
- Theme settings and template JSON live in the DB, so the admin theme editor can change them; the code ships in the image.
- Theme editor: section list with drag-and-drop, per-section settings forms generated from schema, live preview in an iframe with draft settings, publish/rollback versions.
- Brand settings from setup (logo, colours, fonts) are global theme settings.
- Default theme: mobile-first, accessible (WCAG 2.2 AA), respects `prefers-reduced-motion`, Lighthouse ≥ 90 mobile.
- SEO: per-entity title/description, canonical URLs, JSON-LD (Organization, WebSite, Product+Offer, BreadcrumbList, CollectionPage, Article), sitemap index, robots.txt, redirects table.

---

## 12. Analytics

- Client: storefront `<head>` renders `clientSnippet` for each enabled provider; snippets with `requiresConsent` load only after the consent banner is accepted.
- Server: purchase/refund events sent by the worker from outbox events (GA4 Measurement Protocol, Plausible Events API, PostHog capture).
- Built-in: `analytics_daily` aggregated by the worker from first-party events for the admin dashboard, so reports work even without a third-party provider.

---

## 13. Background jobs (`apps/worker`)

Queues: `outbox`, `webhooks-out`, `email`, `images`, `analytics`, `search-index`, `revalidate`, `abandoned-cart`, `inventory-release`, `backups`, `imports`. Each job is idempotent, retried with exponential backoff, dead-lettered after N attempts, and visible in **Admin → Settings → Jobs**.

Outbox dispatcher polls `outbox_events` with `FOR UPDATE SKIP LOCKED`, fans out to queues, marks dispatched.

---

## 14. Backups & upgrades

- Scheduled `pg_dump` (gzip) + media manifest uploaded to the configured storage provider under `backups/`. Retention configurable. `pnpm shopkit backup:restore <file>`.
- Images are semver-tagged. Upgrading = change tag, `docker compose pull && up -d`; `migrate` runs forward-only migrations first. Breaking changes documented in `docs/UPGRADING.md`.

---

## 15. Testing & quality gates

- Unit (Vitest) for `core`, `crypto`, `providers` (mocked HTTP with msw).
- Integration with testcontainers Postgres + Redis for API routes and worker jobs.
- e2e (Playwright) against `docker-compose.yml`: setup wizard, product creation, checkout with Razorpay and Stripe test modes, refund.
- CI: lint, typecheck, test, build images, e2e, `pnpm audit`, SDK freshness check.

---

## 16. Phases

| Phase | Prompt | Outcome |
|---|---|---|
| 1 | `01-foundation.md` | monorepo, Docker, crypto, auth, setup wizard |
| 2 | `02-catalog.md` | products, variants, inventory, collections, media, import |
| 3 | `03-checkout-orders.md` | cart, checkout, payments, orders, customers, emails |
| 4 | `04-operations.md` | fulfillment, shipping, refunds, returns, discounts, tax, reports |
| 5 | `05-storefront-themes.md` | themes + editor, CMS, SEO, analytics |
| 6 | `06-platform-hardening.md` | public API, webhooks, apps, backups, observability, release, PLS migration |

---

## 17. Open decisions

- Licence: MIT (maximum adoption) vs AGPL-3.0 (prevents closed SaaS forks).
- Final project name, npm scope and GHCR namespace.
- Whether to add a GraphQL Storefront API alongside REST (Phase 6+).
