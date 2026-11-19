import { and, asc, desc, eq, inArray, orderLines, orders, returnLines, returns, type Executor } from "@shopkit/db";
import { z } from "zod";
import { writeAudit } from "../audit.js";
import { applyInventoryChanges, type QuantityChange } from "../catalog/inventory.js";
import { refreshProducts } from "../catalog/refresh.js";
import type { Actor, CoreDeps } from "../deps.js";
import { now } from "../deps.js";
import { AppError, notFound } from "../errors.js";
import { enqueueEvent } from "../outbox.js";
import { roundHalf } from "./discount-engine.js";
import { saveDraft } from "./drafts.js";
import { recomputeFulfillmentStatus } from "./fulfillments.js";
import { addOrderEvent, formatMinor, lockOrder } from "./orders.js";
import { refundOrder } from "./refunds.js";

/**
 * Returns (Phase 4): requested by the customer (status page / account) or staff → approved or
 * declined → received (items checked in, optionally restocked at a location) → closed with a
 * refund, an exchange (a draft order credited with the returned value) or nothing.
 */
const REASONS = ["size", "unwanted", "not_as_described", "wrong_item", "defective", "style", "other"] as const;

export const returnRequestInput = z.object({
  lines: z.array(z.object({ orderLineId: z.uuid(), quantity: z.number().int().min(1), reason: z.enum(REASONS).default("other") })).min(1).max(250),
  note: z.string().trim().max(2000).optional(),
  /** Staff-created returns can skip straight to approved. */
  approve: z.boolean().default(false),
  notify: z.boolean().default(true),
});

type ReturnRow = typeof returns.$inferSelect;
type Who = { type: "staff" | "customer"; actor?: Actor; customerId?: string | null };

const eventActor = (w: Who) => (w.type === "customer" ? { type: "customer" as const, id: w.customerId ?? null } : { type: w.actor?.type === "api_key" ? ("api_key" as const) : ("staff" as const), id: w.actor?.id ?? null });

/** Units of each line that can still be returned (shipped, not returned, not in an open return). */
export async function returnableQuantities(db: Executor, orderId: string): Promise<Map<string, number>> {
  const lines = await db.select().from(orderLines).where(eq(orderLines.orderId, orderId));
  const open = await db
    .select({ orderLineId: returnLines.orderLineId, quantity: returnLines.quantity })
    .from(returnLines)
    .innerJoin(returns, eq(returns.id, returnLines.returnId))
    .where(and(eq(returns.orderId, orderId), inArray(returns.status, ["requested", "approved"])));
  const out = new Map<string, number>();
  for (const l of lines) {
    if (l.giftCard) continue;
    const pending = open.filter((o) => o.orderLineId === l.id).reduce((s, o) => s + o.quantity, 0);
    out.set(l.id, Math.max(0, l.fulfilledQuantity - l.returnedQuantity - l.keptQuantity - pending));
  }
  return out;
}

export async function requestReturn(deps: CoreDeps, who: Who, storeId: string, orderId: string, input: z.input<typeof returnRequestInput>) {
  const d = returnRequestInput.parse(input);
  return deps.db.transaction(async (tx) => {
    const order = await lockOrder(tx, storeId, orderId);
    if (!order.placedAt || order.status === "cancelled") throw new AppError("conflict", "This order cannot be returned");
    const available = await returnableQuantities(tx, orderId);
    for (const l of d.lines) {
      const max = available.get(l.orderLineId);
      if (max === undefined) throw notFound("Order line");
      if (l.quantity > max) throw new AppError("validation_failed", max === 0 ? "That item can't be returned (not shipped yet or already returned)" : `Only ${max} of that item can be returned`);
    }
    const count = (await tx.select({ id: returns.id }).from(returns).where(eq(returns.orderId, orderId))).length;
    const approve = who.type === "staff" && d.approve;
    const [r] = await tx
      .insert(returns)
      .values({
        storeId,
        orderId,
        name: `${order.name}-R${count + 1}`,
        status: approve ? "approved" : "requested",
        requestedBy: who.type,
        customerNote: who.type === "customer" ? (d.note ?? null) : null,
        staffNote: who.type === "staff" ? (d.note ?? null) : null,
        approvedAt: approve ? now(deps) : null,
      })
      .returning();
    await tx.insert(returnLines).values(d.lines.map((l) => ({ storeId, returnId: r!.id, orderLineId: l.orderLineId, quantity: l.quantity, reason: l.reason })));
    const units = d.lines.reduce((s, l) => s + l.quantity, 0);
    await addOrderEvent(tx, storeId, orderId, "return_requested", `Return ${r!.name} ${approve ? "created" : "requested"} for ${units} item${units === 1 ? "" : "s"}`, eventActor(who), { returnId: r!.id });
    if (d.notify && approve) await notify(tx, storeId, orderId, r!, "approved", "Your return is approved", "Please send the items back. We'll process your refund once they arrive.");
    if (who.actor) await writeAudit(tx, who.actor, { storeId, action: "return.created", resourceType: "order", resourceId: orderId, metadata: { returnId: r!.id } });
    return r!.id;
  });
}

async function notify(tx: Executor, storeId: string, orderId: string, r: ReturnRow, status: string, heading: string, message: string) {
  await enqueueEvent(tx, { storeId, type: "return.updated", payload: { orderId, returnId: r.id, status, heading, message } });
}

async function lockReturn(tx: Executor, storeId: string, returnId: string) {
  const [r] = await tx.select().from(returns).where(and(eq(returns.storeId, storeId), eq(returns.id, returnId))).for("update");
  if (!r) throw notFound("Return");
  return r;
}

export async function approveReturn(deps: CoreDeps, actor: Actor, storeId: string, returnId: string, input: { notify?: boolean } = {}) {
  await deps.db.transaction(async (tx) => {
    const r = await lockReturn(tx, storeId, returnId);
    if (r.status !== "requested") throw new AppError("conflict", "Only requested returns can be approved");
    await tx.update(returns).set({ status: "approved", approvedAt: now(deps) }).where(eq(returns.id, r.id));
    await addOrderEvent(tx, storeId, r.orderId, "return_approved", `Return ${r.name} approved`, eventActor({ type: "staff", actor }), { returnId: r.id });
    if (input.notify !== false) await notify(tx, storeId, r.orderId, r, "approved", "Your return is approved", "Please send the items back. We'll process your refund once they arrive.");
    await writeAudit(tx, actor, { storeId, action: "return.approved", resourceType: "order", resourceId: r.orderId, metadata: { returnId } });
  });
}

export const declineReturnInput = z.object({ reason: z.string().trim().min(1).max(500), notify: z.boolean().default(true) });

export async function declineReturn(deps: CoreDeps, actor: Actor, storeId: string, returnId: string, input: z.input<typeof declineReturnInput>) {
  const d = declineReturnInput.parse(input);
  await deps.db.transaction(async (tx) => {
    const r = await lockReturn(tx, storeId, returnId);
    if (r.status !== "requested") throw new AppError("conflict", "Only requested returns can be declined");
    await tx.update(returns).set({ status: "declined", declineReason: d.reason, closedAt: now(deps) }).where(eq(returns.id, r.id));
    await addOrderEvent(tx, storeId, r.orderId, "return_declined", `Return ${r.name} declined: ${d.reason}`, eventActor({ type: "staff", actor }), { returnId: r.id });
    if (d.notify) await notify(tx, storeId, r.orderId, r, "declined", "We couldn't accept your return", d.reason);
    await writeAudit(tx, actor, { storeId, action: "return.declined", resourceType: "order", resourceId: r.orderId, metadata: { returnId } });
  });
}

export const receiveReturnInput = z.object({
  /** Per return line: restock or not (default yes) and where. */
  lines: z.array(z.object({ returnLineId: z.uuid(), restock: z.boolean().default(true) })).default([]),
  locationId: z.uuid().nullish(),
});

/** Items arrived: mark them returned and (optionally) put them back in stock. */
export async function receiveReturn(deps: CoreDeps, actor: Actor, storeId: string, returnId: string, input: z.input<typeof receiveReturnInput> = {}) {
  const d = receiveReturnInput.parse(input);
  await deps.db.transaction(async (tx) => {
    const r = await lockReturn(tx, storeId, returnId);
    if (r.status !== "approved" && r.status !== "requested") throw new AppError("conflict", "This return has already been received or closed");
    const order = await lockOrder(tx, storeId, r.orderId);
    const rl = await tx.select().from(returnLines).where(eq(returnLines.returnId, r.id));
    const lines = await tx.select().from(orderLines).where(eq(orderLines.orderId, r.orderId)).for("update");
    const changes: QuantityChange[] = [];
    for (const x of rl) {
      const restock = d.lines.find((l) => l.returnLineId === x.id)?.restock ?? true;
      const line = lines.find((l) => l.id === x.orderLineId)!;
      const loc = d.locationId ?? line.locationId;
      const units = restock && line.inventoryItemId && loc ? Math.min(x.quantity, line.quantity - line.restockedQuantity) : 0;
      if (units > 0) changes.push({ inventoryItemId: line.inventoryItemId!, locationId: loc!, quantity: "available", delta: units });
      await tx.update(returnLines).set({ restock, locationId: loc ?? null }).where(eq(returnLines.id, x.id));
      await tx.update(orderLines).set({ returnedQuantity: line.returnedQuantity + x.quantity, restockedQuantity: line.restockedQuantity + units }).where(eq(orderLines.id, line.id));
      line.returnedQuantity += x.quantity;
    }
    if (changes.length) {
      const productIds = await applyInventoryChanges(tx, actor, storeId, changes, "restock", `Return ${r.name} received`);
      if (productIds.length) await refreshProducts(tx, storeId, productIds);
    }
    await tx.update(returns).set({ status: "received", receivedAt: now(deps) }).where(eq(returns.id, r.id));
    await recomputeFulfillmentStatus(tx, order);
    await addOrderEvent(tx, storeId, r.orderId, "return_received", `Return ${r.name} received${changes.length ? ", items restocked" : ""}`, eventActor({ type: "staff", actor }), { returnId: r.id });
    await writeAudit(tx, actor, { storeId, action: "return.received", resourceType: "order", resourceId: r.orderId, metadata: { returnId } });
  });
}

export const resolveReturnInput = z.discriminatedUnion("resolution", [
  z.object({
    resolution: z.literal("refund"),
    /** Defaults to the returned lines' value (with tax). */
    amount: z.number().int().min(1).optional(),
    shipping: z.number().int().min(0).optional(),
    reason: z.string().trim().max(500).optional(),
    notify: z.boolean().default(true),
  }),
  z.object({
    resolution: z.literal("exchange"),
    lines: z.array(z.object({ variantId: z.uuid(), quantity: z.number().int().min(1).max(999) })).min(1).max(50),
  }),
  z.object({ resolution: z.literal("none"), note: z.string().trim().max(500).optional() }),
]);

/** Closes a received return with a refund, an exchange draft order, or nothing. */
export async function resolveReturn(deps: CoreDeps, actor: Actor, storeId: string, returnId: string, input: z.input<typeof resolveReturnInput>) {
  const d = resolveReturnInput.parse(input);
  const [r] = await deps.db.select().from(returns).where(and(eq(returns.storeId, storeId), eq(returns.id, returnId)));
  if (!r) throw notFound("Return");
  if (r.status !== "received") throw new AppError("conflict", "Receive the items before closing the return");
  const rl = await deps.db.select().from(returnLines).where(eq(returnLines.returnId, r.id));
  let refundId: string | null = null;
  let draftId: string | null = null;
  if (d.resolution === "refund") {
    const result = await refundOrder(deps, actor, storeId, r.orderId, {
      ...(d.amount ? { amount: d.amount } : {}),
      ...(d.shipping ? { shipping: d.shipping } : {}),
      reason: d.reason ?? `Return ${r.name}`,
      lines: rl.map((x) => ({ orderLineId: x.orderLineId, quantity: x.quantity, restock: false })),
      notify: d.notify,
      returnId: r.id,
    });
    refundId = result.refundId;
  } else if (d.resolution === "exchange") {
    const [order] = await deps.db.select().from(orders).where(eq(orders.id, r.orderId));
    const lines = await deps.db.select().from(orderLines).where(inArray(orderLines.id, rl.map((x) => x.orderLineId)));
    const credit = rl.reduce((s, x) => {
      const l = lines.find((y) => y.id === x.orderLineId)!;
      return s + roundHalf(((l.unitPrice * l.quantity - l.discountAmount) * x.quantity) / l.quantity) + (order!.taxesIncluded ? 0 : roundHalf((l.taxAmount * x.quantity) / l.quantity));
    }, 0);
    const draft = await saveDraft(deps, actor, storeId, {
      customerId: order!.customerId,
      email: order!.email,
      phone: order!.phone,
      lines: d.lines,
      shippingAddress: order!.shippingAddress,
      shippingLine: { title: "Exchange shipping", amount: 0 },
      discount: { kind: "fixed_amount", value: Math.max(1, credit), reason: `Exchange credit for ${r.name} (${formatMinor(credit, order!.currency)})` },
      note: `Exchange for return ${r.name} on ${order!.name}`,
      tags: ["exchange"],
    });
    draftId = draft.id;
  }
  await deps.db.transaction(async (tx) => {
    await tx.update(returns).set({ status: "closed", resolution: d.resolution, refundId, exchangeDraftId: draftId, closedAt: now(deps) }).where(eq(returns.id, r.id));
    await addOrderEvent(tx, storeId, r.orderId, "return_closed", `Return ${r.name} closed${d.resolution === "refund" ? " with a refund" : d.resolution === "exchange" ? " with an exchange" : ""}`, eventActor({ type: "staff", actor }), { returnId: r.id, refundId, draftId });
    await writeAudit(tx, actor, { storeId, action: "return.closed", resourceType: "order", resourceId: r.orderId, metadata: { returnId, resolution: d.resolution } });
  });
  return { refundId, draftId };
}

export async function cancelReturn(deps: CoreDeps, actor: Actor, storeId: string, returnId: string) {
  await deps.db.transaction(async (tx) => {
    const r = await lockReturn(tx, storeId, returnId);
    if (r.status !== "requested" && r.status !== "approved") throw new AppError("conflict", "Only open returns can be cancelled");
    await tx.update(returns).set({ status: "cancelled", closedAt: now(deps) }).where(eq(returns.id, r.id));
    await addOrderEvent(tx, storeId, r.orderId, "return_cancelled", `Return ${r.name} cancelled`, eventActor({ type: "staff", actor }), { returnId: r.id });
    await writeAudit(tx, actor, { storeId, action: "return.cancelled", resourceType: "order", resourceId: r.orderId, metadata: { returnId } });
  });
}

export async function listReturns(db: Executor, orderId: string) {
  const rows = await db.select().from(returns).where(eq(returns.orderId, orderId)).orderBy(asc(returns.createdAt));
  const lines = rows.length ? await db.select().from(returnLines).where(inArray(returnLines.returnId, rows.map((r) => r.id))) : [];
  return rows.map((r) => returnView(r, lines.filter((l) => l.returnId === r.id)));
}

export function returnView(r: ReturnRow, lines: (typeof returnLines.$inferSelect)[]) {
  return {
    id: r.id,
    orderId: r.orderId,
    name: r.name,
    status: r.status,
    requestedBy: r.requestedBy,
    customerNote: r.customerNote,
    staffNote: r.staffNote,
    declineReason: r.declineReason,
    resolution: r.resolution,
    refundId: r.refundId,
    exchangeDraftId: r.exchangeDraftId,
    createdAt: r.createdAt.toISOString(),
    receivedAt: r.receivedAt?.toISOString() ?? null,
    closedAt: r.closedAt?.toISOString() ?? null,
    lines: lines.map((l) => ({ id: l.id, orderLineId: l.orderLineId, quantity: l.quantity, reason: l.reason, restock: l.restock })),
  };
}

/** All returns across orders, newest first (admin Returns list). */
export async function listAllReturns(db: Executor, storeId: string, status?: ReturnRow["status"]) {
  const rows = await db
    .select({ r: returns, orderName: orders.name, email: orders.email })
    .from(returns)
    .innerJoin(orders, eq(orders.id, returns.orderId))
    .where(and(eq(returns.storeId, storeId), status ? eq(returns.status, status) : undefined))
    .orderBy(desc(returns.createdAt))
    .limit(200);
  return rows.map((x) => ({ ...returnView(x.r, []), orderName: x.orderName, email: x.email }));
}
