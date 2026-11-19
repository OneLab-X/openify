import { and, desc, discountCodes, discountUsages, discounts, eq, or, sql, type Executor } from "@shopkit/db";
import { z } from "zod";
import { writeAudit } from "../audit.js";
import type { Actor, CoreDeps } from "../deps.js";
import { AppError, notFound } from "../errors.js";

/** Basic discount codes (Phase 3). Phase 4 replaces this with the full discount engine. */
export const discountInput = z
  .object({
    title: z.string().trim().min(1).max(200),
    code: z
      .string()
      .trim()
      .min(3)
      .max(40)
      .regex(/^[A-Za-z0-9_-]+$/, "Letters, numbers, - and _ only"),
    kind: z.enum(["percentage", "fixed_amount", "free_shipping"]),
    /** Basis points for percentage (1000 = 10%), minor units for fixed_amount. */
    value: z.number().int().min(0).max(1_000_000_000).default(0),
    minSubtotal: z.number().int().min(0).nullable().default(null),
    startsAt: z.coerce.date().nullable().default(null),
    endsAt: z.coerce.date().nullable().default(null),
    usageLimit: z.number().int().min(1).nullable().default(null),
    oncePerCustomer: z.boolean().default(false),
    status: z.enum(["active", "disabled"]).default("active"),
  })
  .refine((d) => d.kind !== "percentage" || (d.value > 0 && d.value <= 10_000), { message: "Percentage must be between 0.01% and 100%", path: ["value"] })
  .refine((d) => d.kind !== "fixed_amount" || d.value > 0, { message: "Enter an amount", path: ["value"] })
  .refine((d) => !d.startsAt || !d.endsAt || d.endsAt > d.startsAt, { message: "End must be after start", path: ["endsAt"] });
export type DiscountInput = z.input<typeof discountInput>;

type DiscountRow = typeof discounts.$inferSelect;

export function discountView(d: DiscountRow, code: string) {
  return {
    id: d.id,
    title: d.title,
    code,
    kind: d.kind,
    value: d.value,
    minSubtotal: d.minSubtotal,
    startsAt: d.startsAt?.toISOString() ?? null,
    endsAt: d.endsAt?.toISOString() ?? null,
    usageLimit: d.usageLimit,
    oncePerCustomer: d.oncePerCustomer,
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
    .innerJoin(discountCodes, eq(discountCodes.discountId, discounts.id))
    .where(eq(discounts.storeId, storeId))
    .orderBy(desc(discounts.createdAt));
  return rows.map((r) => discountView(r.d, r.code));
}

export async function getDiscount(db: Executor, storeId: string, id: string) {
  const [row] = await db
    .select({ d: discounts, code: discountCodes.code })
    .from(discounts)
    .innerJoin(discountCodes, eq(discountCodes.discountId, discounts.id))
    .where(and(eq(discounts.storeId, storeId), eq(discounts.id, id)));
  if (!row) throw notFound("Discount");
  return discountView(row.d, row.code);
}

export async function saveDiscount(deps: CoreDeps, actor: Actor, storeId: string, input: DiscountInput, id?: string) {
  const data = discountInput.parse(input);
  const { code, ...fields } = data;
  return deps.db.transaction(async (tx) => {
    const [clash] = await tx
      .select({ discountId: discountCodes.discountId })
      .from(discountCodes)
      .where(and(eq(discountCodes.storeId, storeId), eq(discountCodes.code, code)));
    if (clash && clash.discountId !== id) throw new AppError("conflict", `The code ${code.toUpperCase()} is already used`);
    let discountId = id;
    if (id) {
      const [row] = await tx.update(discounts).set(fields).where(and(eq(discounts.storeId, storeId), eq(discounts.id, id))).returning({ id: discounts.id });
      if (!row) throw notFound("Discount");
      await tx.update(discountCodes).set({ code }).where(eq(discountCodes.discountId, id));
    } else {
      const [row] = await tx.insert(discounts).values({ storeId, ...fields }).returning({ id: discounts.id });
      discountId = row!.id;
      await tx.insert(discountCodes).values({ storeId, discountId, code });
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

export interface ResolvedDiscount {
  discount: DiscountRow;
  codeId: string;
  code: string;
}

/**
 * Finds a code and checks it can apply. Returns a customer-facing reason when it cannot; the
 * caller decides whether that blocks (payment) or just shows (cart).
 */
export async function resolveDiscountCode(
  db: Executor,
  storeId: string,
  rawCode: string,
  ctx: { subtotal: number; email?: string | null; customerId?: string | null; at: Date; excludeOrderId?: string | null },
): Promise<{ ok: true; value: ResolvedDiscount } | { ok: false; error: string }> {
  const code = rawCode.trim();
  if (!code) return { ok: false, error: "Enter a discount code" };
  const [row] = await db
    .select({ d: discounts, codeId: discountCodes.id, code: discountCodes.code })
    .from(discountCodes)
    .innerJoin(discounts, eq(discounts.id, discountCodes.discountId))
    .where(and(eq(discountCodes.storeId, storeId), eq(discountCodes.code, code)));
  const unknown = { ok: false as const, error: `${code.toUpperCase()} is not a valid discount code` };
  if (!row || row.d.status !== "active") return unknown;
  const d = row.d;
  if (d.startsAt && d.startsAt > ctx.at) return unknown;
  if (d.endsAt && d.endsAt <= ctx.at) return { ok: false, error: `${code.toUpperCase()} has expired` };
  if (d.usageLimit !== null && d.usageCount >= d.usageLimit) return { ok: false, error: `${code.toUpperCase()} has reached its usage limit` };
  if (d.minSubtotal !== null && ctx.subtotal < d.minSubtotal) return { ok: false, error: `${code.toUpperCase()} needs a higher order subtotal` };
  if (d.oncePerCustomer && (ctx.email || ctx.customerId)) {
    const who = [ctx.email ? eq(discountUsages.email, ctx.email) : undefined, ctx.customerId ? eq(discountUsages.customerId, ctx.customerId) : undefined].filter(Boolean);
    const [used] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(discountUsages)
      .where(
        and(
          eq(discountUsages.discountId, d.id),
          or(...who),
          ctx.excludeOrderId ? sql`${discountUsages.orderId} <> ${ctx.excludeOrderId}` : undefined,
        ),
      );
    if ((used?.n ?? 0) > 0) return { ok: false, error: `${code.toUpperCase()} can only be used once per customer` };
  }
  return { ok: true, value: { discount: d, codeId: row.codeId, code: row.code } };
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
