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

## Run everything with hot reload

```bash
docker compose -f docker-compose.dev.yml up --build
```

Storefront http://localhost:3000 · Admin http://localhost:3001/admin · API docs http://localhost:4000/api/docs ·
Mailpit http://localhost:8025 (use SMTP host `mailpit`, port `1025` in the wizard). The setup token is in the
`dev` service logs.

## End-to-end tests

The e2e suite drives the production stack from an empty volume:

```bash
docker compose down -v && rm -f .env
SHOPKIT_DOMAIN=localhost ./scripts/install.sh      # add SHOPKIT_HTTPS_PORT=8443 if 443 is taken
pnpm --filter @shopkit/e2e exec playwright install chromium
E2E_BASE_URL=https://localhost pnpm e2e            # or https://localhost:8443
```

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
