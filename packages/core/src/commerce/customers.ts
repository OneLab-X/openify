import { randomInt } from "node:crypto";
import { randomToken, safeEqual, sha256Hex } from "@shopkit/crypto";
import {
  and,
  asc,
  customerAddresses,
  customerTags,
  customers,
  desc,
  eq,
  inArray,
  orders,
  sql,
  type Executor,
  type MailingAddress,
} from "@shopkit/db";
import type { Redis } from "ioredis";
import { z } from "zod";
import { writeAudit } from "../audit.js";
import { assertStrongPassword, hashPassword, verifyDummy, verifyPassword } from "../auth/password.js";
import { decodeCursor, encodeCursor } from "../catalog/cursor.js";
import type { Actor, CoreDeps } from "../deps.js";
import { now } from "../deps.js";
import { AppError, notFound, unauthorized } from "../errors.js";
import { enqueueEvent } from "../outbox.js";
import { getSetting } from "../settings.js";
import { mailingAddressSchema, type MailingAddressInput } from "./address.js";

type CustomerRow = typeof customers.$inferSelect;
type AddressRow = typeof customerAddresses.$inferSelect;

// ── Sessions (Redis, separate cookie from staff; SPEC §10) ───────────────────
export const CUSTOMER_SESSION_SECONDS = 30 * 24 * 60 * 60;
export interface CustomerSession {
  customerId: string;
  storeId: string;
  createdAt: string;
}
const sessionKey = (token: string) => `sk:csess:${sha256Hex(token)}`;

export async function createCustomerSession(redis: Redis, customerId: string, storeId: string): Promise<string> {
  const token = randomToken();
  const session: CustomerSession = { customerId, storeId, createdAt: new Date().toISOString() };
  await redis.set(sessionKey(token), JSON.stringify(session), "EX", CUSTOMER_SESSION_SECONDS);
  return token;
}

export async function touchCustomerSession(redis: Redis, token: string | undefined): Promise<CustomerSession | null> {
  if (!token || token.length > 200) return null;
  const raw = await redis.getex(sessionKey(token), "EX", CUSTOMER_SESSION_SECONDS);
  return raw ? (JSON.parse(raw) as CustomerSession) : null;
}

export async function destroyCustomerSession(redis: Redis, token: string): Promise<void> {
  await redis.del(sessionKey(token));
}

// ── Email one-time codes ─────────────────────────────────────────────────────
export const OTP_TTL_SECONDS = 10 * 60;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_SENDS_PER_HOUR = 5;
const otpKey = (storeId: string, email: string) => `sk:cotp:${storeId}:${sha256Hex(email.toLowerCase())}`;
const otpRateKey = (storeId: string, email: string) => `sk:cotp-rate:${storeId}:${sha256Hex(email.toLowerCase())}`;

export const emailInput = z.object({ email: z.email().max(254).transform((e) => e.toLowerCase()) });
export const otpVerifyInput = emailInput.extend({ code: z.string().regex(/^\d{6}$/, "Enter the 6-digit code") });

/**
 * Sends a sign-in code. Always "succeeds" (no account enumeration); the code is emailed through the
 * outbox. Codes live 10 minutes, allow 5 attempts, and at most 5 are sent per address per hour.
 */
export async function requestCustomerOtp(deps: CoreDeps, storeId: string, input: z.input<typeof emailInput>): Promise<void> {
  const { email } = emailInput.parse(input);
  const sent = await deps.redis.incr(otpRateKey(storeId, email));
  if (sent === 1) await deps.redis.expire(otpRateKey(storeId, email), 3600);
  if (sent > OTP_SENDS_PER_HOUR) throw new AppError("rate_limited", "Too many codes requested. Try again in an hour.");
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  await deps.redis.set(otpKey(storeId, email), JSON.stringify({ hash: sha256Hex(code), attempts: 0 }), "EX", OTP_TTL_SECONDS);
  await deps.db.transaction((tx) => enqueueEvent(tx, { storeId, type: "customer.otp_requested", payload: { email, code, minutes: OTP_TTL_SECONDS / 60 } }));
}

async function consumeOtp(redis: Redis, storeId: string, email: string, code: string): Promise<boolean> {
  const key = otpKey(storeId, email);
  const raw = await redis.get(key);
  if (!raw) return false;
  const state = JSON.parse(raw) as { hash: string; attempts: number };
  if (state.attempts >= OTP_MAX_ATTEMPTS) {
    await redis.del(key);
    return false;
  }
  if (!safeEqual(state.hash, sha256Hex(code))) {
    await redis.set(key, JSON.stringify({ ...state, attempts: state.attempts + 1 }), "KEEPTTL");
    return false;
  }
  await redis.del(key);
  return true;
}

export interface CustomerLogin {
  token: string;
  customer: CustomerView;
}

/** Verifies a code; first sign-in creates the account (Shopify-style passwordless accounts). */
export async function verifyCustomerOtp(deps: CoreDeps, storeId: string, input: z.input<typeof otpVerifyInput>): Promise<CustomerLogin> {
  const { email, code } = otpVerifyInput.parse(input);
  if (!(await consumeOtp(deps.redis, storeId, email, code))) throw new AppError("unauthorized", "That code is wrong or has expired");
  const at = now(deps);
  const customer = await deps.db.transaction(async (tx) => {
    const [row] = await tx
      .insert(customers)
      .values({ storeId, email, verifiedAt: at, lastLoginAt: at })
      .onConflictDoUpdate({ target: [customers.storeId, customers.email], set: { verifiedAt: sql`coalesce(${customers.verifiedAt}, ${at})`, lastLoginAt: at } })
      .returning();
    return row!;
  });
  if (customer.state === "disabled") throw new AppError("forbidden", "This account is disabled");
  return { token: await createCustomerSession(deps.redis, customer.id, storeId), customer: await customerView(deps.db, customer) };
}

export const passwordLoginInput = emailInput.extend({ password: z.string().min(1).max(256) });
export const registerInput = emailInput.extend({
  password: z.string().min(1).max(256),
  firstName: z.string().trim().max(100).optional(),
  lastName: z.string().trim().max(100).optional(),
  marketingConsent: z.boolean().default(false),
});

async function assertPasswordAuth(db: Executor, storeId: string) {
  const cfg = await getSetting(db, storeId, "checkout.config");
  if (cfg.customerAuth !== "password") throw new AppError("bad_request", "This shop signs customers in with an email code");
}

export async function loginCustomerWithPassword(deps: CoreDeps, storeId: string, input: z.input<typeof passwordLoginInput>): Promise<CustomerLogin> {
  await assertPasswordAuth(deps.db, storeId);
  const { email, password } = passwordLoginInput.parse(input);
  const [row] = await deps.db.select().from(customers).where(and(eq(customers.storeId, storeId), eq(customers.email, email)));
  if (!row?.passwordHash) {
    await verifyDummy(password);
    throw unauthorized("Email or password is incorrect");
  }
  if (!(await verifyPassword(row.passwordHash, password))) throw unauthorized("Email or password is incorrect");
  if (row.state === "disabled") throw new AppError("forbidden", "This account is disabled");
  await deps.db.update(customers).set({ lastLoginAt: now(deps) }).where(eq(customers.id, row.id));
  return { token: await createCustomerSession(deps.redis, row.id, storeId), customer: await customerView(deps.db, row) };
}

export async function registerCustomer(deps: CoreDeps, storeId: string, input: z.input<typeof registerInput>): Promise<CustomerLogin> {
  await assertPasswordAuth(deps.db, storeId);
  const data = registerInput.parse(input);
  await assertStrongPassword(data.password, [data.email, data.firstName ?? "", data.lastName ?? ""]);
  const passwordHash = await hashPassword(data.password);
  const at = now(deps);
  const [row] = await deps.db
    .insert(customers)
    .values({
      storeId,
      email: data.email,
      firstName: data.firstName || null,
      lastName: data.lastName || null,
      passwordHash,
      marketingConsent: data.marketingConsent,
      marketingConsentAt: data.marketingConsent ? at : null,
      lastLoginAt: at,
    })
    // A checkout may already have created a guest record for this email; claim it only if it has no password.
    .onConflictDoUpdate({
      target: [customers.storeId, customers.email],
      set: { passwordHash, lastLoginAt: at, firstName: sql`coalesce(${customers.firstName}, excluded.first_name)`, lastName: sql`coalesce(${customers.lastName}, excluded.last_name)` },
      setWhere: sql`${customers.passwordHash} is null`,
    })
    .returning();
  if (!row) throw new AppError("conflict", "An account with this email already exists. Sign in instead.");
  return { token: await createCustomerSession(deps.redis, row.id, storeId), customer: await customerView(deps.db, row) };
}

// ── Views ────────────────────────────────────────────────────────────────────
export function addressView(a: AddressRow) {
  return {
    id: a.id,
    firstName: a.firstName,
    lastName: a.lastName,
    company: a.company,
    line1: a.line1,
    line2: a.line2,
    city: a.city,
    province: a.province,
    postalCode: a.postalCode,
    country: a.country,
    phone: a.phone,
    isDefault: a.isDefault,
  };
}

export async function customerView(db: Executor, c: CustomerRow) {
  const [addresses, tagRows] = await Promise.all([
    db.select().from(customerAddresses).where(eq(customerAddresses.customerId, c.id)).orderBy(desc(customerAddresses.isDefault), asc(customerAddresses.createdAt)),
    db.select({ tag: customerTags.tag }).from(customerTags).where(eq(customerTags.customerId, c.id)).orderBy(asc(customerTags.tag)),
  ]);
  return {
    id: c.id,
    email: c.email,
    firstName: c.firstName,
    lastName: c.lastName,
    phone: c.phone,
    state: c.state,
    marketingConsent: c.marketingConsent,
    hasPassword: c.passwordHash !== null,
    note: c.note,
    tags: tagRows.map((t) => t.tag),
    ordersCount: c.ordersCount,
    totalSpent: c.totalSpent,
    currency: c.currency,
    lastOrderAt: c.lastOrderAt?.toISOString() ?? null,
    createdAt: c.createdAt.toISOString(),
    addresses: addresses.map(addressView),
  };
}
export type CustomerView = Awaited<ReturnType<typeof customerView>>;

export async function getCustomer(db: Executor, storeId: string, id: string): Promise<CustomerRow> {
  const [row] = await db.select().from(customers).where(and(eq(customers.storeId, storeId), eq(customers.id, id)));
  if (!row) throw notFound("Customer");
  return row;
}

// ── Account (storefront) ─────────────────────────────────────────────────────
export const accountUpdateInput = z.object({
  firstName: z.string().trim().max(100).nullish(),
  lastName: z.string().trim().max(100).nullish(),
  phone: z.string().trim().max(40).nullish(),
  marketingConsent: z.boolean().optional(),
});

export async function updateAccount(deps: CoreDeps, storeId: string, customerId: string, input: z.input<typeof accountUpdateInput>) {
  const d = accountUpdateInput.parse(input);
  const current = await getCustomer(deps.db, storeId, customerId);
  const consentChanged = d.marketingConsent !== undefined && d.marketingConsent !== current.marketingConsent;
  const [row] = await deps.db
    .update(customers)
    .set({
      ...(d.firstName !== undefined ? { firstName: d.firstName || null } : {}),
      ...(d.lastName !== undefined ? { lastName: d.lastName || null } : {}),
      ...(d.phone !== undefined ? { phone: d.phone || null } : {}),
      ...(consentChanged ? { marketingConsent: d.marketingConsent!, marketingConsentAt: now(deps) } : {}),
    })
    .where(eq(customers.id, customerId))
    .returning();
  return customerView(deps.db, row!);
}

export const addressInput = mailingAddressSchema.extend({ isDefault: z.boolean().default(false) });

export async function saveCustomerAddress(deps: CoreDeps, storeId: string, customerId: string, input: z.input<typeof addressInput>, addressId?: string) {
  const { isDefault, ...a } = addressInput.parse(input);
  return deps.db.transaction(async (tx) => {
    await getCustomer(tx, storeId, customerId);
    const count = (await tx.select({ id: customerAddresses.id }).from(customerAddresses).where(eq(customerAddresses.customerId, customerId))).length;
    const makeDefault = isDefault || count === 0 || (count === 1 && !!addressId);
    if (makeDefault) await tx.update(customerAddresses).set({ isDefault: false }).where(eq(customerAddresses.customerId, customerId));
    let id = addressId;
    if (addressId) {
      const [row] = await tx
        .update(customerAddresses)
        .set({ ...a, ...(makeDefault ? { isDefault: true } : {}) })
        .where(and(eq(customerAddresses.customerId, customerId), eq(customerAddresses.id, addressId)))
        .returning({ id: customerAddresses.id });
      if (!row) throw notFound("Address");
    } else {
      if (count >= 20) throw new AppError("validation_failed", "You can save up to 20 addresses");
      const [row] = await tx.insert(customerAddresses).values({ storeId, customerId, ...a, isDefault: makeDefault }).returning({ id: customerAddresses.id });
      id = row!.id;
    }
    return customerView(tx, await getCustomer(tx, storeId, customerId)).then((v) => ({ customer: v, addressId: id! }));
  });
}

export async function deleteCustomerAddress(deps: CoreDeps, storeId: string, customerId: string, addressId: string) {
  return deps.db.transaction(async (tx) => {
    const [row] = await tx
      .delete(customerAddresses)
      .where(and(eq(customerAddresses.storeId, storeId), eq(customerAddresses.customerId, customerId), eq(customerAddresses.id, addressId)))
      .returning();
    if (!row) throw notFound("Address");
    if (row.isDefault) {
      const [next] = await tx.select({ id: customerAddresses.id }).from(customerAddresses).where(eq(customerAddresses.customerId, customerId)).orderBy(asc(customerAddresses.createdAt)).limit(1);
      if (next) await tx.update(customerAddresses).set({ isDefault: true }).where(eq(customerAddresses.id, next.id));
    }
    return customerView(tx, await getCustomer(tx, storeId, customerId));
  });
}

// ── Orders → customers ───────────────────────────────────────────────────────
/**
 * Every placed order belongs to a customer record (created for guests, like Shopify), so the admin
 * can show order history and lifetime value. Consent is only ever switched on here, never off.
 */
export async function ensureCustomerForOrder(
  tx: Executor,
  storeId: string,
  input: { email: string; phone?: string | null; currency: string; marketingConsent: boolean; address?: MailingAddress | null; at: Date },
): Promise<string> {
  const [row] = await tx
    .insert(customers)
    .values({
      storeId,
      email: input.email.toLowerCase(),
      firstName: input.address?.firstName ?? null,
      lastName: input.address?.lastName ?? null,
      phone: input.phone ?? input.address?.phone ?? null,
      currency: input.currency,
      marketingConsent: input.marketingConsent,
      marketingConsentAt: input.marketingConsent ? input.at : null,
    })
    .onConflictDoUpdate({
      target: [customers.storeId, customers.email],
      set: {
        firstName: sql`coalesce(${customers.firstName}, excluded.first_name)`,
        lastName: sql`coalesce(${customers.lastName}, excluded.last_name)`,
        phone: sql`coalesce(${customers.phone}, excluded.phone)`,
        currency: sql`coalesce(${customers.currency}, excluded.currency)`,
        ...(input.marketingConsent ? { marketingConsent: true, marketingConsentAt: sql`coalesce(${customers.marketingConsentAt}, excluded.marketing_consent_at)` } : {}),
      },
    })
    .returning({ id: customers.id });
  const id = row!.id;
  if (input.address) {
    const [existing] = await tx.select({ id: customerAddresses.id }).from(customerAddresses).where(eq(customerAddresses.customerId, id)).limit(1);
    if (!existing) {
      const { firstName, lastName, company, line1, line2, city, province, postalCode, country, phone } = input.address;
      await tx.insert(customerAddresses).values({ storeId, customerId: id, firstName, lastName, company, line1, line2, city, province, postalCode, country, phone, isDefault: true });
    }
  }
  return id;
}

/** Recomputes orders count, lifetime value (paid − refunded) and last order date. */
export async function refreshCustomerStats(tx: Executor, customerId: string | null): Promise<void> {
  if (!customerId) return;
  await tx.execute(sql`
    update customers c set
      orders_count = s.n, total_spent = s.spent, last_order_at = s.last
    from (
      select count(*)::int as n, coalesce(sum(amount_paid - amount_refunded), 0)::bigint as spent, max(placed_at) as last
      from ${orders} where customer_id = ${customerId} and placed_at is not null and status <> 'cancelled'
    ) s
    where c.id = ${customerId}`);
}

// ── Admin ────────────────────────────────────────────────────────────────────
export const customerListQuery = z.object({
  q: z.string().trim().max(200).optional(),
  sort: z.enum(["created_desc", "spent_desc"]).default("created_desc"),
  tag: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(250).default(50),
  cursor: z.string().max(400).optional(),
});

export async function listCustomers(db: Executor, storeId: string, query: z.input<typeof customerListQuery>) {
  const q = customerListQuery.parse(query);
  const like = q.q ? `%${q.q.replace(/[\\%_]/g, "\\$&")}%` : null;
  const after = decodeCursor(q.cursor, 2);
  const key = q.sort === "spent_desc" ? sql`c.total_spent` : sql`c.created_at`;
  const cast = q.sort === "spent_desc" ? sql.raw("bigint") : sql.raw("timestamptz");
  const rows = await db.execute<{
    id: string;
    email: string;
    first_name: string | null;
    last_name: string | null;
    phone: string | null;
    state: "enabled" | "disabled";
    marketing_consent: boolean;
    orders_count: number;
    total_spent: string;
    currency: string | null;
    last_order_at: Date | null;
    created_at: Date;
    sort_key: string;
  }>(sql`
    select c.id, c.email, c.first_name, c.last_name, c.phone, c.state, c.marketing_consent, c.orders_count, c.total_spent::text,
           c.currency, c.last_order_at, c.created_at, ${key}::text as sort_key
    from ${customers} c
    where c.store_id = ${storeId}
      ${like ? sql`and (c.email ilike ${like} or concat_ws(' ', c.first_name, c.last_name) ilike ${like} or c.phone ilike ${like})` : sql``}
      ${q.tag ? sql`and exists (select 1 from ${customerTags} t where t.customer_id = c.id and t.tag = ${q.tag})` : sql``}
      ${after ? sql`and (${key}, c.id) < (${after[0] as string}::${cast}, ${after[1] as string}::uuid)` : sql``}
    order by ${key} desc, c.id desc
    limit ${q.limit + 1}`);
  const pageRows = rows.rows.slice(0, q.limit);
  const last = pageRows.at(-1);
  return {
    items: pageRows.map((r) => ({
      id: r.id,
      email: r.email,
      name: [r.first_name, r.last_name].filter(Boolean).join(" ") || null,
      phone: r.phone,
      state: r.state,
      marketingConsent: r.marketing_consent,
      ordersCount: r.orders_count,
      totalSpent: Number(r.total_spent),
      currency: r.currency,
      lastOrderAt: r.last_order_at ? new Date(r.last_order_at).toISOString() : null,
      createdAt: new Date(r.created_at).toISOString(),
    })),
    nextCursor: rows.rows.length > q.limit && last ? encodeCursor([last.sort_key, last.id]) : null,
  };
}

export const adminCustomerInput = z.object({
  email: z.email().max(254).transform((e) => e.toLowerCase()),
  firstName: z.string().trim().max(100).nullish(),
  lastName: z.string().trim().max(100).nullish(),
  phone: z.string().trim().max(40).nullish(),
  note: z.string().max(5000).nullish(),
  marketingConsent: z.boolean().default(false),
  state: z.enum(["enabled", "disabled"]).default("enabled"),
  tags: z.array(z.string().trim().min(1).max(100)).max(50).default([]),
});

export async function saveCustomerAdmin(deps: CoreDeps, actor: Actor, storeId: string, input: z.input<typeof adminCustomerInput>, id?: string) {
  const d = adminCustomerInput.parse(input);
  const at = now(deps);
  return deps.db.transaction(async (tx) => {
    let customerId = id;
    const fields = {
      email: d.email,
      firstName: d.firstName || null,
      lastName: d.lastName || null,
      phone: d.phone || null,
      note: d.note || null,
      state: d.state,
    };
    if (id) {
      const current = await getCustomer(tx, storeId, id);
      const [clash] = await tx.select({ id: customers.id }).from(customers).where(and(eq(customers.storeId, storeId), eq(customers.email, d.email)));
      if (clash && clash.id !== id) throw new AppError("conflict", "Another customer has this email");
      await tx
        .update(customers)
        .set({ ...fields, ...(current.marketingConsent !== d.marketingConsent ? { marketingConsent: d.marketingConsent, marketingConsentAt: at } : {}) })
        .where(eq(customers.id, id));
    } else {
      const [row] = await tx
        .insert(customers)
        .values({ storeId, ...fields, marketingConsent: d.marketingConsent, marketingConsentAt: d.marketingConsent ? at : null })
        .onConflictDoNothing()
        .returning({ id: customers.id });
      if (!row) throw new AppError("conflict", "A customer with this email already exists");
      customerId = row.id;
    }
    await tx.delete(customerTags).where(eq(customerTags.customerId, customerId!));
    const unique = [...new Set(d.tags.map((t) => t.toLowerCase()))];
    if (unique.length) await tx.insert(customerTags).values(unique.map((tag) => ({ storeId, customerId: customerId!, tag })));
    await writeAudit(tx, actor, { storeId, action: id ? "customer.updated" : "customer.created", resourceType: "customer", resourceId: customerId! });
    return customerView(tx, await getCustomer(tx, storeId, customerId!));
  });
}

/** Admin detail: profile, addresses, tags and recent orders. */
export async function getCustomerAdmin(db: Executor, storeId: string, id: string) {
  const c = await getCustomer(db, storeId, id);
  const recent = await db
    .select({
      id: orders.id,
      name: orders.name,
      placedAt: orders.placedAt,
      total: orders.total,
      currency: orders.currency,
      financialStatus: orders.financialStatus,
      fulfillmentStatus: orders.fulfillmentStatus,
      status: orders.status,
    })
    .from(orders)
    .where(and(eq(orders.storeId, storeId), eq(orders.customerId, id), sql`${orders.placedAt} is not null`))
    .orderBy(desc(orders.placedAt))
    .limit(50);
  return {
    ...(await customerView(db, c)),
    orders: recent.map((o) => ({ ...o, name: o.name ?? "", placedAt: o.placedAt!.toISOString() })),
  };
}

export async function customersByIds(db: Executor, ids: string[]) {
  if (ids.length === 0) return new Map<string, CustomerRow>();
  const rows = await db.select().from(customers).where(inArray(customers.id, ids));
  return new Map(rows.map((r) => [r.id, r]));
}

export type { MailingAddressInput };
