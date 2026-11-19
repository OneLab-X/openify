import { and, customers, desc, draftOrders, eq, orders, sql, type Executor } from "@shopkit/db";
import { z } from "zod";
import { writeAudit } from "../audit.js";
import type { Actor, CoreDeps } from "../deps.js";
import { now } from "../deps.js";
import { AppError, notFound } from "../errors.js";
import { mailingAddressSchema } from "./address.js";
import { linesWithImages } from "./carts.js";
import { markOrderPaid, nextNumber, addOrderEvent, placeOrder, reserveInventory, totalsFromPricing, writeOrderLines } from "./orders.js";
import { priceLines } from "./pricing.js";

/** Draft orders and manual order creation from the admin (Phase 3 item 4). */
export const draftInput = z.object({
  customerId: z.uuid().nullish(),
  email: z.email().max(254).nullish(),
  phone: z.string().trim().max(40).nullish(),
  lines: z.array(z.object({ variantId: z.uuid(), quantity: z.number().int().min(1).max(999) })).max(250).default([]),
  shippingAddress: mailingAddressSchema.nullish(),
  shippingLine: z.object({ title: z.string().trim().min(1).max(100), amount: z.number().int().min(0) }).nullish(),
  discount: z.object({ kind: z.enum(["percentage", "fixed_amount"]), value: z.number().int().min(1), reason: z.string().trim().max(200).optional() }).nullish(),
  note: z.string().max(5000).nullish(),
  tags: z.array(z.string().trim().min(1).max(100)).max(50).default([]),
});
export type DraftInput = z.input<typeof draftInput>;

type DraftRow = typeof draftOrders.$inferSelect;

async function priceDraft(db: Executor, storeId: string, d: Pick<DraftRow, "lines" | "shippingAddress" | "shippingLine" | "discount" | "email" | "customerId">) {
  return priceLines(db, storeId, {
    lines: d.lines.map((l, i) => ({ variantId: l.variantId, quantity: l.quantity, ref: String(i) })),
    shippingAddress: d.shippingAddress,
    customShipping: d.shippingLine ?? null,
    manualDiscount: d.discount,
    customer: { id: d.customerId, email: d.email },
  });
}

export async function draftView(deps: CoreDeps, storeId: string, d: DraftRow) {
  const pricing = await priceDraft(deps.db, storeId, d);
  const [order] = d.orderId ? await deps.db.select({ name: orders.name }).from(orders).where(eq(orders.id, d.orderId)) : [];
  return {
    id: d.id,
    name: d.name,
    status: d.status,
    customerId: d.customerId,
    email: d.email,
    phone: d.phone,
    shippingAddress: d.shippingAddress,
    shippingLine: d.shippingLine,
    discount: d.discount,
    note: d.note,
    tags: d.tags,
    orderId: d.orderId,
    orderName: order?.name ?? null,
    currency: pricing.currency,
    lines: (await linesWithImages(deps, pricing)).map((l) => ({ ...l, id: l.variantId })),
    unavailable: pricing.unavailable.map((u) => ({ variantId: u.variantId, reason: u.reason })),
    subtotal: pricing.subtotal,
    discountTotal: pricing.discountTotal,
    shippingTotal: pricing.shippingTotal,
    taxTotal: pricing.taxTotal,
    total: pricing.total,
    taxesIncluded: pricing.taxesIncluded,
    taxLines: pricing.taxLines,
    blockers: pricing.blockers,
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
  };
}

async function getDraftRow(db: Executor, storeId: string, id: string) {
  const [row] = await db.select().from(draftOrders).where(and(eq(draftOrders.storeId, storeId), eq(draftOrders.id, id)));
  if (!row) throw notFound("Draft order");
  return row;
}

export async function getDraft(deps: CoreDeps, storeId: string, id: string) {
  return draftView(deps, storeId, await getDraftRow(deps.db, storeId, id));
}

export async function listDrafts(deps: CoreDeps, storeId: string) {
  const rows = await deps.db.select().from(draftOrders).where(eq(draftOrders.storeId, storeId)).orderBy(desc(draftOrders.createdAt)).limit(200);
  return Promise.all(
    rows.map(async (d) => {
      const p = await priceDraft(deps.db, storeId, d);
      return { id: d.id, name: d.name, status: d.status, email: d.email, total: p.total, currency: p.currency, itemCount: p.itemCount, createdAt: d.createdAt.toISOString() };
    }),
  );
}

async function resolveCustomer(db: Executor, storeId: string, d: z.output<typeof draftInput>) {
  if (!d.customerId) return { customerId: null, email: d.email?.toLowerCase() ?? null };
  const [c] = await db.select().from(customers).where(and(eq(customers.storeId, storeId), eq(customers.id, d.customerId)));
  if (!c) throw notFound("Customer");
  return { customerId: c.id, email: d.email?.toLowerCase() ?? c.email };
}

export async function saveDraft(deps: CoreDeps, actor: Actor, storeId: string, input: DraftInput, id?: string) {
  const d = draftInput.parse(input);
  return deps.db.transaction(async (tx) => {
    const who = await resolveCustomer(tx, storeId, d);
    const fields = {
      ...who,
      phone: d.phone || null,
      lines: d.lines,
      shippingAddress: d.shippingAddress ?? null,
      shippingLine: d.shippingLine ?? null,
      discount: d.discount ?? null,
      note: d.note || null,
      tags: [...new Set(d.tags.map((t) => t.toLowerCase()))],
    };
    let row: DraftRow;
    if (id) {
      const current = await getDraftRow(tx, storeId, id);
      if (current.status === "completed") throw new AppError("conflict", "This draft is already an order");
      [row] = (await tx.update(draftOrders).set(fields).where(eq(draftOrders.id, id)).returning()) as [DraftRow];
    } else {
      const number = await nextNumber(tx, storeId, "draft");
      [row] = (await tx.insert(draftOrders).values({ storeId, number, name: `D${number}`, createdBy: actor.id ?? null, ...fields }).returning()) as [DraftRow];
    }
    await writeAudit(tx, actor, { storeId, action: id ? "draft_order.updated" : "draft_order.created", resourceType: "draft_order", resourceId: row.id });
    return row;
  }).then((row) => draftView(deps, storeId, row));
}

export async function deleteDraft(deps: CoreDeps, actor: Actor, storeId: string, id: string) {
  await deps.db.transaction(async (tx) => {
    const current = await getDraftRow(tx, storeId, id);
    if (current.status === "completed") throw new AppError("conflict", "Completed drafts are kept with their order");
    await tx.delete(draftOrders).where(eq(draftOrders.id, id));
    await writeAudit(tx, actor, { storeId, action: "draft_order.deleted", resourceType: "draft_order", resourceId: id });
  });
}

export const completeDraftInput = z.object({ paymentPending: z.boolean().default(false) });

/** Turns a draft into a placed order: same pricing, stock reserved, optionally recorded as paid. */
export async function completeDraft(deps: CoreDeps, actor: Actor, storeId: string, id: string, input: z.input<typeof completeDraftInput>) {
  const { paymentPending } = completeDraftInput.parse(input);
  const orderId = await deps.db.transaction(async (tx) => {
    const draft = await getDraftRow(tx, storeId, id);
    await tx.select({ id: draftOrders.id }).from(draftOrders).where(eq(draftOrders.id, id)).for("update");
    if (draft.status === "completed") throw new AppError("conflict", "This draft is already an order");
    if (!draft.email) throw new AppError("validation_failed", "Add a customer email");
    const pricing = await priceDraft(tx, storeId, draft);
    if (pricing.blockers.length) throw new AppError("conflict", pricing.blockers[0]!, { blockers: pricing.blockers });
    const [order] = await tx
      .insert(orders)
      .values({
        storeId,
        ...totalsFromPricing(pricing),
        email: draft.email,
        phone: draft.phone,
        customerId: draft.customerId,
        shippingAddress: draft.shippingAddress,
        billingAddress: draft.shippingAddress,
        note: draft.note,
        tags: draft.tags,
        paymentProvider: "manual",
        sourceName: "draft",
        createdBy: actor.id ?? null,
      })
      .returning();
    await writeOrderLines(tx, storeId, order!.id, pricing);
    await reserveInventory(tx, storeId, order!);
    await addOrderEvent(tx, storeId, order!.id, "created_from_draft", `Created from draft ${draft.name}`, { type: "staff", id: actor.id ?? null });
    await placeOrder(tx, deps, order!, { paid: !paymentPending, actor: { type: "staff", id: actor.id ?? null } });
    await tx.update(draftOrders).set({ status: "completed", orderId: order!.id, completedAt: now(deps) }).where(eq(draftOrders.id, id));
    await writeAudit(tx, actor, { storeId, action: "draft_order.completed", resourceType: "draft_order", resourceId: id, metadata: { orderId: order!.id } });
    return order!.id;
  });
  if (!paymentPending) await markOrderPaid(deps, actor, storeId, orderId, { note: "Paid when the order was created" });
  return { orderId };
}

/** Variant picker for draft orders: title/SKU search over sellable variants. */
export async function searchVariants(deps: CoreDeps, storeId: string, q: string, limit = 20) {
  const like = `%${q.trim().replace(/[\\%_]/g, "\\$&")}%`;
  const rows = await deps.db.execute<{
    variant_id: string;
    product_id: string;
    product_title: string;
    variant_title: string;
    sku: string | null;
    price: string;
    currency: string;
    available: number | null;
    tracked: boolean | null;
    policy: "deny" | "continue";
  }>(sql`
    select v.id as variant_id, p.id as product_id, p.title as product_title, v.title as variant_title, v.sku, v.price::text, v.currency,
           (select sum(l.available)::int from inventory_levels l where l.inventory_item_id = ii.id) as available, ii.tracked, v.inventory_policy as policy
    from product_variants v
    join products p on p.id = v.product_id
    left join inventory_items ii on ii.variant_id = v.id
    where v.store_id = ${storeId} and p.status = 'active'
      and (p.title ilike ${like} or v.title ilike ${like} or v.sku ilike ${like})
    order by p.title, v.position
    limit ${Math.min(Math.max(limit, 1), 50)}`);
  return rows.rows.map((r) => ({
    variantId: r.variant_id,
    productId: r.product_id,
    productTitle: r.product_title,
    variantTitle: r.variant_title === "Default Title" ? null : r.variant_title,
    sku: r.sku,
    price: Number(r.price),
    currency: r.currency,
    available: r.tracked ? (r.available ?? 0) : null,
    inventoryPolicy: r.policy,
  }));
}
