# 06 — Platform and production hardening

Prepend `00-master-context.md`, then:

```
Phase 6 — Platform and production hardening. Read SPEC §4, §9, §10, §13, §14, §15.

Build:
1. Public Admin API: scoped API keys (hashed, last-used, expiry), OpenAPI docs at /api/docs,
   rate limits per key, versioned paths (/api/admin/v1).
2. Outgoing webhooks: subscriptions per topic (orders/create, orders/paid, products/update,
   customers/create, refunds/create, ...), HMAC-SHA256 signature header, retries with
   exponential backoff, delivery log, manual replay, auto-disable after repeated failures.
3. App/plugin system: an app is an npm package with a manifest that can register providers,
   admin pages (rendered in an iframe with a signed session token), storefront sections,
   and webhook handlers. Install/uninstall from Admin → Apps; permissions requested in the
   manifest and approved by the owner.
4. Importers: from Shopify (products, collections, customers, orders, pages via a Shopify
   Admin API token) and from WooCommerce CSV. Background jobs with progress and reports.
5. Markets groundwork: multi-currency display with rates, storefront translations (i18n
   of theme strings and product content tables).
6. Backups: scheduled pg_dump + media manifest to the configured storage provider,
   retention, `pnpm shopkit backup:restore`, restore drill documented and tested in CI.
7. Observability: pino JSON logs with request ids, OpenTelemetry traces across
   api → worker, /healthz and /readyz, Prometheus metrics (HTTP, queue depth, job failures,
   payment webhook lag), sample Grafana dashboard.
8. Security: CSP with nonces, CSRF on cookie routes, rate limits per IP and per key,
   dependency audit + container scan (Trivy) in CI, SECURITY.md with disclosure process.
9. Release: GitHub Actions building multi-arch (amd64/arm64) images to GHCR, semver tags,
   CHANGELOG, docs/UPGRADING.md, Helm chart for Kubernetes (HPA for api/storefront/worker),
   docs site (installation, providers, theming, API, contributing).
10. Scaling check: read-replica support for storefront reads, PgBouncer in compose profile,
    load test (k6) of storefront product page and checkout with targets in docs.
11. PLS migration: script that imports the PrettyLittleStore data — orders from MongoDB,
    products/categories/artists from the Google Sheet (Apps Script feed), images from the
    Google Drive links — into a Shopkit install, idempotent and with a dry-run mode
    (pattern: PLS scripts/import-orders.mjs).

Done when:
- a third-party app installed from a local package adds a payment provider and an admin
  page without core code changes;
- webhook deliveries survive a receiver outage and replay correctly;
- backup → wipe volumes → restore yields an identical store (checked in CI);
- k6 targets met and documented; Helm chart deploys to kind in CI.
```
