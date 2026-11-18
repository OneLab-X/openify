# 01 — Foundation + setup wizard

Prepend `00-master-context.md`, then:

```
Phase 1 — Foundation + setup wizard. Read SPEC §1–7, §10, §13.

Build:
1. Monorepo skeleton: apps/api, apps/worker, apps/admin, apps/storefront; packages/db, core,
   crypto, providers, sdk, ui, config. Turborepo pipelines for lint, typecheck, test, build.
2. Docker: multi-stage, non-root Dockerfiles in docker/; docker-compose.yml with postgres,
   redis, migrate (one-shot), api, worker, admin, storefront, caddy, and a `minio` profile;
   docker-compose.dev.yml with hot reload; healthchecks on every service.
3. scripts/install.sh per SPEC §5 (generates .env with SHOPKIT_MASTER_KEY, POSTGRES_PASSWORD,
   SESSION_SECRET, REVALIDATE_SECRET, PUBLIC_URL; prints the back-up-your-key warning).
4. packages/crypto: envelope AES-256-GCM per SPEC §6 with AAD, keyring + key_version,
   `pnpm shopkit keys:rotate` and `keys:verify` CLI. 100% unit test coverage, including
   tamper detection (wrong AAD, flipped byte, wrong key version).
5. packages/db: Drizzle schema + migrations for stores, settings, setup_state, domains,
   staff_users, roles, role_permissions, api_keys, audit_logs, provider_credentials,
   outbox_events, media, locations. UUIDv7 helper.
6. Auth: staff email+password (argon2id), Redis sessions in httpOnly cookies, TOTP 2FA,
   RBAC (owner, admin, staff) with permission strings, login rate limit + lockout, CSRF.
7. Setup API + admin /setup wizard: setup token (SPEC §5), steps 0–8, server-side step
   persistence, "Test connection" per provider, settings forms generated from provider zod
   schemas, secrets write-only (UI shows last4).
8. Providers this phase (real, tested): storage Local + S3-compatible (MinIO/AWS S3);
   payments Razorpay + Cash on Delivery; email SMTP + Resend; analytics GA4 + Plausible.
   All other providers in SPEC §7 appear in the wizard as "coming soon".
9. Worker: outbox dispatcher with FOR UPDATE SKIP LOCKED, email queue, image queue stub.
10. Admin shell after setup: sidebar nav (Home, Orders, Products, Customers, Content,
    Analytics, Settings), Settings pages for every wizard section, audit log list.
11. Storefront: "coming soon" page while setup is required; afterwards a placeholder home
    showing store name and logo from the API.

Done when:
- fresh clone → ./scripts/install.sh → https://localhost → wizard completes → admin
  dashboard shell loads, storefront shows store name + logo;
- `select ciphertext from provider_credentials` shows no plaintext; API never returns secrets;
- Playwright e2e covers the whole wizard including a failed and a successful Test connection;
- setup endpoints reject requests without the token and after setup completes.
```
