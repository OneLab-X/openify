# Shopkit

Open-source, self-hosted alternative to Shopify. Install with Docker, open the URL, and a setup wizard walks you through your store details, logo, and providers for storage (local, S3, R2, GCS, Azure, Google Drive…), payments (Razorpay, Stripe, PayPal, Cashfree, PhonePe, COD…), email and analytics (GA4, Plausible…). Provider secrets are stored encrypted in PostgreSQL.

> Status: planning. No application code yet.

## Stack
pnpm + Turborepo monorepo · TypeScript · Fastify API · Next.js admin and storefront · PostgreSQL · Redis + BullMQ workers · Docker Compose + Caddy.

## Docs
- [docs/SPEC.md](docs/SPEC.md): architecture, data model, provider contracts, encryption, setup wizard.
- [docs/prompts/](docs/prompts/): build prompts, one per phase. Paste `00-master-context.md` followed by the phase prompt into your coding agent, one phase at a time.
- [docs/PLS-REFERENCE.md](docs/PLS-REFERENCE.md): reference code from PrettyLittleStore.

## Phases
1. Foundation + setup wizard
2. Catalog and media
3. Cart, checkout, payments, orders, customers
4. Merchant operations (fulfillment, shipping, refunds, discounts, tax, reports)
5. Storefront themes, CMS, SEO, analytics
6. Platform (API, webhooks, apps), backups, observability, release

## Licence
To be decided (MIT or AGPL-3.0) before the first public release.
