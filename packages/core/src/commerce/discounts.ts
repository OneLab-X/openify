import {
  and,
  customerTags,
  desc,
  discountCodes,
  discountUsages,
  discounts,
  eq,
  inArray,
  or,
  sql,
  type Executor,
} from "@shopkit/db";
import { z } from "zod";
import { writeAudit } from "../audit.js";
import type { Actor, CoreDeps } from "../deps.js";
import { AppError, notFound } from "../errors.js";
import type { EngineDiscount } from "./discount-engine.js";

/**
 * Discounts (Phase 4): codes and automatic discounts; % off, fixed off, free shipping and buy X
 * get Y; targeting all items, collections or products; minimum subtotal/quantity; customer
 * eligibility; total and per-customer usage limits; a schedule; and combination rules. This
 * module loads and validates candidates; `discount-engine.ts` decides what applies.
 */
const targetSel = z.object({
  target: z.enum(["all", "collections", "products"]).default("all"),
  productIds: z.array(z.uuid()).max(250).default([]),
  collectionIds: z.array(z.uuid()).max(250).default([]),
});

export const bxgyInput = z.object({
  buy: targetSel.extend({ quantity: z.number().int().min(1).max(1000) }),
  get: targetSel.extend({ quantity: z.number().int().min(1).max(1000), percentOff: z.number().int().min(1).max(10_000).default(10_000) }),
  usesPerOrder: z.number().int().min(1).max(1000).nullable().default(1),
});

export const discountInput = z
  .object({
    title: z.string().trim().min(1).max(200),
    method: z.enum(["code", "automatic"]).default("code"),
    code: z
      .string()
      .trim()
      .min(3)
      .max(40)
      .regex(/^[A-Za-z0-9_-]+$/, "Letters, numbers, - and _ only")
      .nullish(),
    kind: z.enum(["percentage", "fixed_amount", "free_shipping", "buy_x_get_y"]),
    /** Basis points for percentage (1000 = 10%), minor units for fixed_amount. */
    value: z.number().int().min(0).max(1_000_000_000).default(0),
    target: z.enum(["all", "collections", "products"]).default("all"),
    productIds: z.array(z.uuid()).max(250).default([]),
    collectionIds: z.array(z.uuid()).max(250).default([]),
    perItem: z.boolean().default(false),
    bxgy: bxgyInput.nullish(),
    minSubtotal: z.number().int().min(0).nullable().default(null),
    minQuantity: z.number().int().min(1).nullable().default(null),
    maxShippingAmount: z.number().int().min(0).nullable().default(null),
    eligibility: z.enum(["all", "customers", "tags"]).default("all"),
    customerIds: z.array(z.uuid()).max(500).default([]),
    customerTags: z.array(z.string().trim().min(1).max(100)).max(50).default([]),
    startsAt: z.coerce.date().nullable().default(null),
    endsAt: z.coerce.date().nullable().default(null),
    usageLimit: z.number().int().min(1).nullable().default(null),
    usageLimitPerCustomer: z.number().int().min(1).nullable().default(null),
    /** Phase 3 field, kept for API compatibility: true = usageLimitPerCustomer 1. */
    oncePerCustomer: z.boolean().optional(),
    combinesWith: z.object({ product: z.boolean(), order: z.boolean(), shipping: z.boolean() }).default({ product: false, order: false, shipping: false }),
    status: z.enum(["active", "disabled"]).default("active"),
  })
  .refine((d) => d.method !== "code" || !!d.code, { message: "Enter a code", path: ["code"] })
  .refine((d) => d.kind !== "percentage" || (d.value > 0 && d.value <= 10_000), { message: "Percentage must be between 0.01% and 100%", path: ["value"] })
  .refine((d) => d.kind !== "fixed_amount" || d.value > 0, { message: "Enter an amount", path: ["value"] })
  .refine((d) => d.kind !== "buy_x_get_y" || !!d.bxgy, { message: "Set what the customer buys and gets", path: ["bxgy"] })
  .refine((d) => d.target === "all" || d.kind === "free_shipping" || d.kind === "buy_x_get_y" || (d.target === "products" ? d.productIds.length : d.collectionIds.length) > 0, {
    message: "Choose at least one product or collection",
    path: ["target"],
  })
  .refine((d) => d.eligibility !== "customers" || d.customerIds.length > 0, { message: "Choose at least one customer", path: ["customerIds"] })
  .refine((d) => d.eligibility !== "tags" || d.customerTags.length > 0, { message: "Enter at least one customer tag", path: ["customerTags"] })
  .refine((d) => !d.startsAt || !d.endsAt || d.endsAt > d.startsAt, { message: "End must be after start", path: ["endsAt"] });
export type DiscountInput = z.input<typeof discountInput>;

type DiscountRow = typeof discounts.$inferSelect;

export function discountView(d: DiscountRow, code: string | null) {
  return {
    id: d.id,
    title: d.title,
    method: d.method,
    code,
    kind: d.kind,
    value: d.value,
    target: d.target,
    productIds: d.productIds,
    collectionIds: d.collectionIds,
    perItem: d.perItem,
    bxgy: d.bxgy,
    minSubtotal: d.minSubtotal,
    minQuantity: d.minQuantity,
    maxShippingAmount: d.maxShippingAmount,
    eligibility: d.eligibility,
    customerIds: d.customerIds,
    customerTags: d.customerTags,
    startsAt: d.startsAt?.toISOString() ?? null,
    endsAt: d.endsAt?.toISOString() ?? null,
    usageLimit: d.usageLimit,
    usageLimitPerCustomer: d.usageLimitPerCustomer,
    oncePerCustomer: d.usageLimitPerCustomer === 1,
    combinesWith: d.combinesWith,
    status: d.status,
    usageCount: d.usageCount,
    createdAt: d.createdAt.toISOString(),
  };
}
export type DiscountView = ReturnType<typeof discountView>;

export async function listDiscounts(db: Executor, storeId: string) {
  const rows = await db
    .select({ d: discounts, code: discountCodes.code })
    .from(discounts)
    .leftJoin(discountCodes, eq(discountCodes.discountId, discounts.id))
    .where(eq(discounts.storeId, storeId))
    .orderBy(desc(discounts.createdAt));
  return rows.map((r) => discountView(r.d, r.code));
}

export async function getDiscount(db: Executor, storeId: string, id: string) {
  const [row] = await db
    .select({ d: discounts, code: discountCodes.code })
    .from(discounts)
    .leftJoin(discountCodes, eq(discountCodes.discountId, discounts.id))
    .where(and(eq(discounts.storeId, storeId), eq(discounts.id, id)));
  if (!row) throw notFound("Discount");
  return discountView(row.d, row.code);
}

export async function saveDiscount(deps: CoreDeps, actor: Actor, storeId: string, input: DiscountInput, id?: string) {
  const data = discountInput.parse(input);
  const { code: rawCode, oncePerCustomer, bxgy, customerTags: tags, ...rest } = data;
  const code = data.method === "code" ? rawCode! : null;
  const fields = {
    ...rest,
    bxgy: (bxgy ?? null),
    customerTags: [...new Set(tags.map((t) => t.toLowerCase()))],
    usageLimitPerCustomer: rest.usageLimitPerCustomer ?? (oncePerCustomer ? 1 : null),
    oncePerCustomer: (rest.usageLimitPerCustomer ?? (oncePerCustomer ? 1 : null)) === 1,
    // Free shipping and automatic discounts carry no value of their own.
    value: data.kind === "free_shipping" || data.kind === "buy_x_get_y" ? 0 : rest.value,
  };
  return deps.db.transaction(async (tx) => {
    if (code) {
      const [clash] = await tx
        .select({ discountId: discountCodes.discountId })
        .from(discountCodes)
        .where(and(eq(discountCodes.storeId, storeId), eq(discountCodes.code, code)));
      if (clash && clash.discountId !== id) throw new AppError("conflict", `The code ${code.toUpperCase()} is already used`);
    }
    let discountId = id;
    if (id) {
      const [row] = await tx.update(discounts).set(fields).where(and(eq(discounts.storeId, storeId), eq(discounts.id, id))).returning({ id: discounts.id });
      if (!row) throw notFound("Discount");
      if (code) {
        const updated = await tx.update(discountCodes).set({ code }).where(eq(discountCodes.discountId, id)).returning({ id: discountCodes.id });
        if (updated.length === 0) await tx.insert(discountCodes).values({ storeId, discountId: id, code });
      } else {
        await tx.delete(discountCodes).where(eq(discountCodes.discountId, id));
      }
    } else {
      const [row] = await tx.insert(discounts).values({ storeId, ...fields }).returning({ id: discounts.id });
      discountId = row!.id;
      if (code) await tx.insert(discountCodes).values({ storeId, discountId, code });
    }
    await writeAudit(tx, actor, { storeId, action: id ? "discount.updated" : "discount.created", resourceType: "discount", resourceId: discountId! });
    return getDiscount(tx, storeId, discountId!);
  });
}

export async function deleteDiscount(deps: CoreDeps, actor: Actor, storeId: string, id: string) {
  await deps.db.transaction(async (tx) => {
    const [row] = await tx.delete(discounts).where(and(eq(discounts.storeId, storeId), eq(discounts.id, id))).returning({ id: discounts.id });
    if (!row) throw notFound("Discount");
    await writeAudit(tx, actor, { storeId, action: "discount.deleted", resourceType: "discount", resourceId: id });
  });
}

export interface DiscountContext {
  email?: string | null;
  customerId?: string | null;
  at: Date;
  /** The order being re-priced: its own usage does not count against limits. */
  excludeOrderId?: string | null;
}

export interface Candidate extends EngineDiscount {
  codeId: string | null;
}

function toCandidate(d: DiscountRow, code: string | null, codeId: string | null): Candidate {
  return {
    id: d.id,
    title: d.title,
    code,
    codeId,
    kind: d.kind,
    value: d.value,
    target: d.target,
    productIds: d.productIds,
    collectionIds: d.collectionIds,
    perItem: d.perItem,
    bxgy: d.bxgy,
    minSubtotal: d.minSubtotal,
    minQuantity: d.minQuantity,
    maxShippingAmount: d.maxShippingAmount,
    combinesWith: d.combinesWith,
  };
}

/** Status, schedule, eligibility and usage limits. Returns a customer-facing reason, or null. */
async function checkAvailable(db: Executor, d: DiscountRow, label: string, ctx: DiscountContext, tags: () => Promise<string[]>): Promise<string | null> {
  const invalid = `${label} is not a valid discount code`;
  if (d.status !== "active") return invalid;
  if (d.startsAt && d.startsAt > ctx.at) return invalid;
  if (d.endsAt && d.endsAt <= ctx.at) return `${label} has expired`;
  if (d.usageLimit !== null && d.usageCount >= d.usageLimit) return `${label} has reached its usage limit`;
  if (d.eligibility === "customers" && (!ctx.customerId || !d.customerIds.includes(ctx.customerId))) return `${label} isn't available for your account`;
  if (d.eligibility === "tags") {
    const mine = await tags();
    if (!d.customerTags.some((t) => mine.includes(t.toLowerCase()))) return `${label} isn't available for your account`;
  }
  if (d.usageLimitPerCustomer !== null && (ctx.email || ctx.customerId)) {
    const who = [ctx.email ? eq(discountUsages.email, ctx.email) : undefined, ctx.customerId ? eq(discountUsages.customerId, ctx.customerId) : undefined].filter(Boolean);
    const [used] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(discountUsages)
      .where(and(eq(discountUsages.discountId, d.id), or(...who), ctx.excludeOrderId ? sql`${discountUsages.orderId} <> ${ctx.excludeOrderId}` : undefined));
    if ((used?.n ?? 0) >= d.usageLimitPerCustomer) return d.usageLimitPerCustomer === 1 ? `${label} can only be used once per customer` : `${label} can only be used ${d.usageLimitPerCustomer} times per customer`;
  }
  return null;
}

/**
 * Loads the discounts that may apply: every active automatic discount plus the entered codes.
 * Codes that cannot be used come back in `errors` (keyed by the code as entered).
 */
export async function loadDiscountCandidates(db: Executor, storeId: string, codes: readonly string[], ctx: DiscountContext) {
  let tagCache: string[] | null = null;
  const tags = async () => {
    if (tagCache) return tagCache;
    tagCache = ctx.customerId ? (await db.select({ tag: customerTags.tag }).from(customerTags).where(eq(customerTags.customerId, ctx.customerId))).map((t) => t.tag.toLowerCase()) : [];
    return tagCache;
  };
  const candidates: Candidate[] = [];
  const errors: { code: string; reason: string }[] = [];

  const autos = await db.select().from(discounts).where(and(eq(discounts.storeId, storeId), eq(discounts.method, "automatic"), eq(discounts.status, "active")));
  for (const d of autos) if (!(await checkAvailable(db, d, d.title, ctx, tags))) candidates.push(toCandidate(d, null, null));

  const wanted = [...new Set(codes.map((c) => c.trim()).filter(Boolean))];
  const rows = wanted.length
    ? await db
        .select({ d: discounts, codeId: discountCodes.id, code: discountCodes.code })
        .from(discountCodes)
        .innerJoin(discounts, eq(discounts.id, discountCodes.discountId))
        .where(and(eq(discountCodes.storeId, storeId), inArray(discountCodes.code, wanted)))
    : [];
  for (const code of wanted) {
    const row = rows.find((r) => r.code.toLowerCase() === code.toLowerCase());
    if (!row) {
      errors.push({ code, reason: `${code.toUpperCase()} is not a valid discount code` });
      continue;
    }
    const problem = await checkAvailable(db, row.d, row.code.toUpperCase(), ctx, tags);
    if (problem) errors.push({ code, reason: problem });
    else if (!candidates.some((c) => c.id === row.d.id)) candidates.push(toCandidate(row.d, row.code, row.codeId));
  }
  return { candidates, errors };
}

/** Records a use when an order is placed (idempotent per discount + order). */
export async function recordDiscountUsage(tx: Executor, storeId: string, input: { discountId: string; codeId: string | null; orderId: string; email: string | null; customerId: string | null }) {
  const inserted = await tx
    .insert(discountUsages)
    .values({ storeId, ...input })
    .onConflictDoNothing()
    .returning({ id: discountUsages.id });
  if (inserted.length === 0) return;
  await tx.update(discounts).set({ usageCount: sql`${discounts.usageCount} + 1` }).where(eq(discounts.id, input.discountId));
  if (input.codeId) await tx.update(discountCodes).set({ usageCount: sql`${discountCodes.usageCount} + 1` }).where(eq(discountCodes.id, input.codeId));
}
