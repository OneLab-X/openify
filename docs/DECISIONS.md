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
