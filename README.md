# Shopkit

Open-source, self-hosted alternative to Shopify. Install with Docker, open the URL, and a setup wizard walks you through your store details, logo, and providers for storage (local, S3, R2, GCS, Azure, Google Drive…), payments (Razorpay, Stripe, PayPal, Cashfree, PhonePe, COD…), email and analytics (GA4, Plausible…). Provider secrets are stored encrypted in PostgreSQL.

> Status: Phases 1–2 (foundation + setup wizard; catalog and media) implemented. Not production-ready yet.

## Stack
pnpm + Turborepo monorepo · TypeScript · Fastify API · Next.js admin and storefront · PostgreSQL · Redis + BullMQ workers · Docker Compose + Caddy.

## Quick start

```bash
git clone <repo> shopkit && cd shopkit
./scripts/install.sh            # asks for your domain, writes .env, starts everything
docker compose logs api | grep "setup token"
```

Open `https://<your-domain>/admin/setup`, paste the token and follow the wizard. **Back up `.env`**: losing
`SHOPKIT_MASTER_KEY` makes stored provider secrets unrecoverable.

## Docs
- [docs/SPEC.md](docs/SPEC.md): architecture, data model, provider contracts, encryption, setup wizard.
- [docs/prompts/](docs/prompts/): build prompts, one per phase. Paste `00-master-context.md` followed by the phase prompt into your coding agent, one phase at a time.
- [docs/PLS-REFERENCE.md](docs/PLS-REFERENCE.md): reference code from PrettyLittleStore.
- [docs/DECISIONS.md](docs/DECISIONS.md): changes to and interpretations of the SPEC.
- [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md): local development, tests, OpenAPI/SDK, key rotation.
- [CHANGELOG.md](CHANGELOG.md)

## Phases
1. Foundation + setup wizard
2. Catalog and media
3. Cart, checkout, payments, orders, customers
4. Merchant operations (fulfillment, shipping, refunds, discounts, tax, reports)
5. Storefront themes, CMS, SEO, analytics
6. Platform (API, webhooks, apps), backups, observability, release

## Licence
To be decided (MIT or AGPL-3.0) before the first public release.
