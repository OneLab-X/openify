# 00 — Master context

Paste this at the top of every phase prompt (01–06).

```
You are building Shopkit, an open-source (licence TBD: MIT or AGPL-3.0), self-hosted
alternative to Shopify. Read docs/SPEC.md fully before writing code; it is the source of
truth for architecture, data model, provider contracts, secret encryption and the setup
wizard. Do not change architecture decisions in SPEC without stating why in docs/DECISIONS.md.
docs/PLS-REFERENCE.md points to a working single-store shop whose payment, order, email and
admin code you should study (not copy blindly) when building the matching features.

Stack: pnpm + Turborepo monorepo, TypeScript strict, Node 22, Fastify 5 API, Drizzle ORM on
PostgreSQL 17, Redis 7 + BullMQ, Next.js (App Router) for admin and storefront, Tailwind 4 +
shadcn/ui, zod everywhere at boundaries, OpenAPI generated from zod schemas, Vitest +
testcontainers for tests, Playwright for e2e.

Next.js note: the installed Next.js may be newer than your training data. Before writing any
Next.js code, read the relevant guide in node_modules/next/dist/docs/ and follow its
conventions and deprecation notices.

Rules:
- Every tenant table has store_id. Money is integer minor units + currency. IDs are UUIDv7.
- Business logic lives in packages/core, not in route handlers or React components.
- All side effects after a DB write go through the outbox table, never inline.
- Provider secrets only via packages/crypto; never log them, return them, or put them in env vars.
- Prices are always computed server-side; never trust amounts from the browser.
- Webhooks: verify signature on raw body, dedupe by provider event id, treat as source of truth.
- Every new provider implements the adapter interface in SPEC §7 and registers in the registry;
  its settings form is generated from its zod schemas.
- Each phase ends green: pnpm lint, pnpm typecheck, pnpm test, e2e for the phase, and
  `docker compose up` boots clean on an empty volume. Update docs/ and CHANGELOG.md.
- Ask before adding a dependency not named in SPEC.
- Work in small commits, one feature per commit, with tests in the same commit.
- At the end, report what was built, what was skipped and why, and any SPEC deviations.
```
