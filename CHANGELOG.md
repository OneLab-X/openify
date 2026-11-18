# Changelog

All notable changes are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased] — Phase 1: foundation + setup wizard

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
