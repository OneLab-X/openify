# Development

Requirements: Node 22, pnpm 9 (`corepack enable`), Docker (tests use testcontainers).

```bash
pnpm install
pnpm build          # builds packages and apps (turbo)
pnpm lint
pnpm typecheck
pnpm test           # unit + integration (starts Postgres/Redis/RustFS/Mailpit containers)
```

testcontainers uses the endpoint of your active `docker context` (Colima, OrbStack…) when `DOCKER_HOST` is
not set.

## Storage contract tests

`packages/providers/test/storage-contract.ts` is the suite every storage adapter must pass. `pnpm test` runs it
against local disk, RustFS (S3, MinIO/S3-compatible, R2, B2), fake-gcs-server, Azurite and an in-process Google
Drive fake. To run it against real accounts, export one variable per provider with the saved credential shape and
run the providers tests:

```bash
export SHOPKIT_LIVE_STORAGE_R2='{"config":{"accountId":"…","bucket":"…"},"secrets":{"accessKeyId":"…","secretAccessKey":"…"}}'
# also: _S3, _S3_COMPATIBLE, _GCS, _AZURE_BLOB, _B2, _GOOGLE_DRIVE
pnpm --filter @shopkit/providers exec vitest run test/storage-contract-live.test.ts
```

Objects are written under a random `contract-…/` prefix and deleted afterwards. Direct (browser) uploads to a bucket
also need a CORS rule allowing `PUT` with `content-type` (and `x-ms-blob-type` on Azure) from the shop's origin.

## Search

Postgres full-text + `pg_trgm` works out of the box. For Meilisearch, set `COMPOSE_PROFILES=meilisearch` and
`MEILISEARCH_URL=http://meilisearch:7700` in `.env` (install.sh already generated `MEILISEARCH_MASTER_KEY`),
`docker compose up -d`, then build the index once:

```bash
docker compose exec api node dist/cli.js search:reindex
```

## Product CSV

Admin → Products → Import / export accepts Shopify's product CSV (up to 20 MB) and exports the same format.
Imports run in the worker's `imports` queue; re-importing a file updates products by handle. Image URLs in the
CSV are downloaded only from public addresses; test stacks can set `IMPORT_ALLOW_PRIVATE_URLS=true` on the worker.

## Run everything with hot reload

```bash
docker compose -f docker-compose.dev.yml up --build
```

Storefront http://localhost:3000 · Admin http://localhost:3001/admin · API docs http://localhost:4000/api/docs ·
Mailpit http://localhost:8025 (use SMTP host `mailpit`, port `1025` in the wizard). The setup token is in the
`dev` service logs.

## End-to-end tests

The e2e suite drives the production stack from an empty volume, with the e2e overlay that adds a local payment
sandbox (fake Razorpay + Stripe APIs, widgets and signed webhooks) and Mailpit:

```bash
export COMPOSE_FILE=docker-compose.yml:docker-compose.e2e.yml
docker compose down -v && rm -f .env
SHOPKIT_DOMAIN=localhost ./scripts/install.sh      # add SHOPKIT_HTTPS_PORT=8443 if 443 is taken
pnpm --filter @shopkit/e2e exec playwright install chromium
E2E_BASE_URL=https://localhost pnpm e2e            # or https://localhost:8443
```

The overlay publishes the sandbox on `127.0.0.1:14200` (`/_events`, `/_orders`) and Mailpit on
`127.0.0.1:18025`; override with `SANDBOX_HOST_PORT` / `MAILPIT_HOST_PORT`. Never deploy the overlay.

The `setup` project (wizard) runs first; the `catalog` project depends on the store it launches (product with
2 options × 6 variants × 4 images visible on the storefront within 5 s, 500-product Shopify CSV import and
idempotent re-import, collections, filters, search, inventory, bulk actions). Run one project with
`pnpm e2e --project=catalog` only against a stack where the wizard has already completed. The `checkout`
project buys with Razorpay and Stripe test mode through the sandbox, replays their webhooks, checks stock moved
once and the confirmation email went once, then refunds through the provider.

```bash
```

## Checkout and payments

- Pricing lives in `packages/core/src/commerce/pricing.ts`; every surface calls it. Never accept an amount
  from a request body.
- Payment adapters must pass `packages/providers/test/payment-contract.test.ts` (fixtures in
  `test/fixtures/payments/<provider>/`). Add a harness entry for a new adapter.
- Webhook URL for a provider: `https://<shop>/api/webhooks/payments/<provider id>` (shown in Settings → Payments).
- Unpaid checkouts hold stock for `checkout.config.reservationMinutes` (default 30); the `inventory-release`
  queue frees it. Abandoned-checkout reminders: Settings → Notifications (delay, on/off); the worker scans every
  `ABANDONED_SCAN_INTERVAL_MS` (default 60 s).
- Storefront writes need the `X-Shopkit-Client: storefront` header (CSRF); `apps/storefront/src/lib/shop-client.ts`
  adds it.

## Operations (Phase 4)

- Shipping zones, discounts and tax all price through `priceLines`; the discount engine
  (`packages/core/src/commerce/discount-engine.ts`) is pure, so new rules get a row in
  `packages/core/test/discount-engine.test.ts`.
- Carrier tracking webhook URL: `https://<shop>/api/webhooks/shipping/<provider id>` (Shiprocket, Delhivery,
  EasyPost). Courier tracking links for manual fulfillments: `packages/providers/src/shipping/couriers.ts`.
- `analytics_daily` is refreshed every `ANALYTICS_ROLLUP_INTERVAL_MS` (default 15 min) for today and yesterday.
- Staff invitations link to `/admin/invite/<token>`; with Mailpit (e2e overlay) the email lands at
  `http://127.0.0.1:18025`.
- e2e: the `operations` project depends on `checkout` (it fulfils and returns that suite's Razorpay order).

## API, SDK and OpenAPI

Routes declare zod schemas; OpenAPI is generated from them. After changing a route:

```bash
pnpm openapi        # writes packages/sdk/openapi.json and regenerates packages/sdk/src/schema.d.ts
pnpm sdk:check      # CI: fails if either is stale
```

## Master key rotation (SPEC §6)

1. Add the new key next to the old one: `SHOPKIT_MASTER_KEY_2=$(openssl rand -base64 32)` in `.env`
   (keep `SHOPKIT_MASTER_KEY` as version 1).
2. `docker compose up -d`, then `docker compose exec api node dist/cli.js keys:rotate --to 2`.
3. Set `SHOPKIT_MASTER_KEY_VERSION=2`, restart, and run `keys:verify`.
4. Remove the old key only after `keys:verify` reports 0 failures and you have a backup of `.env`.

## Adding a provider

Implement a `ProviderDefinition` in `packages/providers/src/<kind>/` (zod `configSchema` + `secretsSchema`
with `.meta({ title, description })`, `create(ctx)` returning the SPEC §7 methods), register it in
`default-registry.ts`, and add tests (msw for HTTP APIs, a container for protocols). The admin form is
generated from the schemas automatically.
