import { and, desc, eq, inArray, orderLines, orders, refundLines, refunds, sql, transactions, uuidv7, type Executor } from "@shopkit/db";
import { z } from "zod";
import { writeAudit } from "../audit.js";
import { applyInventoryChanges, type QuantityChange } from "../catalog/inventory.js";
import { refreshProducts } from "../catalog/refresh.js";
import { loadProvider } from "../credentials.js";
import type { Actor, CoreDeps } from "../deps.js";
import { now } from "../deps.js";
import { AppError, notFound } from "../errors.js";
import { enqueueEvent } from "../outbox.js";
import { refreshCustomerStats } from "./customers.js";
import { roundHalf } from "./discount-engine.js";
import { recomputeFulfillmentStatus } from "./fulfillments.js";
import { refundToGiftCards } from "./gift-cards.js";
import { addOrderEvent, financialFor, formatMinor, lockOrder, type OrderRow } from "./orders.js";

/**
 * Refunds (Phase 4): full or partial, by line (with tax share) or by amount, optional shipping
 * refund, restock toggle per line. The money goes back through `PaymentProvider.refund` (keyed by
 * our refund id); any part paid with gift cards goes back onto the cards. A refund the provider
 * reports as pending only counts once the provider confirms it (webhook or status), so
 * `amount_refunded` is always the sum of successful refund transactions.
 */
export const refundInput = z.object({
  /** Total to refund; when omitted it is the suggested amount for the lines and shipping. */
  amount: z.number().int().min(1).optional(),
  reason: z.string().trim().max(500).optional(),
  lines: z
    .array(
      z.object({
        orderLineId: z.uuid(),
        quantity: z.number().int().min(1),
        restock: z.boolean().default(true),
        /** Where restocked units go (defaults to where the line was reserved). */
        locationId: z.uuid().nullish(),
      }),
    )
    .max(250)
    .default([]),
  /** Shipping to refund (minor units); `fullShipping` refunds what is left of it. */
  shipping: z.number().int().min(0).optional(),
  fullShipping: z.boolean().optional(),
  notify: z.boolean().default(true),
  /** Set when the refund settles a return (stock was handled when the items were received). */
  returnId: z.uuid().optional(),
});
export type RefundInput = z.input<typeof refundInput>;

type LineRow = typeof orderLines.$inferSelect;

/** What the refund dialog shows: per-line amounts, tax, shipping left and the most that can go back. */
export async function calculateRefund(db: Executor, storeId: string, orderId: string, input: Omit<RefundInput, "amount" | "notify" | "reason">) {
  const d = refundInput.omit({ amount: true }).parse({ ...input, notify: false });
  const [order] = await db.select().from(orders).where(and(eq(orders.storeId, storeId), eq(orders.id, orderId)));
  if (!order?.placedAt) throw notFound("Order");
  const lines = d.lines.length ? await db.select().from(orderLines).where(and(eq(orderLines.orderId, orderId), inArray(orderLines.id, d.lines.map((l) => l.orderLineId)))) : [];
  let subtotal = 0;
  let tax = 0;
  for (const l of d.lines) {
    const line = lines.find((x) => x.id === l.orderLineId);
    if (!line) throw notFound("Order line");
    if (l.quantity > line.quantity - line.refundedQuantity) throw new AppError("validation_failed", `Only ${line.quantity - line.refundedQuantity} of ${line.title} can be refunded`);
    subtotal += roundHalf(((line.unitPrice * line.quantity - line.discountAmount) * l.quantity) / line.quantity);
    if (!order.taxesIncluded) tax += roundHalf((line.taxAmount * l.quantity) / line.quantity);
  }
  const [shipRow] = await db.select({ n: sql<number>`coalesce(sum(${refunds.shippingAmount}), 0)::bigint` }).from(refunds).where(and(eq(refunds.orderId, orderId), inArray(refunds.status, ["pending", "success"])));
  const shippingLeft = Math.max(0, order.shippingTotal - Number(shipRow?.n ?? 0));
  const shipping = Math.min(d.fullShipping ? shippingLeft : (d.shipping ?? 0), shippingLeft);
  const refundable = await refundableAmount(db, order);
  return { subtotal, tax, shipping, shippingLeft, suggested: Math.min(subtotal + tax + shipping, refundable), refundable };
}

/** Paid minus refunded minus refunds still pending at the provider. */
async function refundableAmount(db: Executor, order: OrderRow): Promise<number> {
  const [pending] = await db.select({ n: sql<number>`coalesce(sum(${refunds.amount}), 0)::bigint` }).from(refunds).where(and(eq(refunds.orderId, order.id), eq(refunds.status, "pending")));
  return order.amountPaid - order.amountRefunded - Number(pending?.n ?? 0);
}

/** amount_refunded = Σ successful refund transactions; financial status follows. */
export async function syncRefundTotals(tx: Executor, order: OrderRow) {
  const [row] = await tx
    .select({ n: sql<number>`coalesce(sum(${transactions.amount}), 0)::bigint` })
    .from(transactions)
    .where(and(eq(transactions.orderId, order.id), eq(transactions.kind, "refund"), eq(transactions.status, "success")));
  const amountRefunded = Number(row?.n ?? 0);
  const financialStatus = order.status === "cancelled" && order.amountPaid === 0 ? order.financialStatus : financialFor({ ...order, amountRefunded });
  await tx.update(orders).set({ amountRefunded, financialStatus }).where(eq(orders.id, order.id));
  Object.assign(order, { amountRefunded, financialStatus });
}

const staffActor = (a: Actor) => ({ type: a.type === "api_key" ? ("api_key" as const) : a.type === "staff" ? ("staff" as const) : ("system" as const), id: a.id ?? null });

export async function refundOrder(deps: CoreDeps, actor: Actor, storeId: string, orderId: string, input: RefundInput) {
  const data = refundInput.parse(input);
  const [order] = await deps.db.select().from(orders).where(and(eq(orders.storeId, storeId), eq(orders.id, orderId)));
  if (!order?.placedAt) throw notFound("Order");
  const calc = await calculateRefund(deps.db, storeId, orderId, data);
  const amount = data.amount ?? calc.suggested;
  if (amount <= 0) throw new AppError("validation_failed", "Enter an amount to refund");
  if (amount > calc.refundable) throw new AppError("validation_failed", `You can refund at most ${formatMinor(calc.refundable, order.currency)}`);
  const lines = data.lines.length ? await deps.db.select().from(orderLines).where(and(eq(orderLines.orderId, orderId), inArray(orderLines.id, data.lines.map((l) => l.orderLineId)))) : [];

  // Split between the payment provider and gift cards (provider first).
  const sales = await deps.db.select().from(transactions).where(and(eq(transactions.orderId, orderId), inArray(transactions.kind, ["sale", "refund"]))).orderBy(desc(transactions.amount));
  const providerSales = sales.filter((t) => t.kind === "sale" && t.status === "success" && t.provider !== "gift_card");
  const providerRefunded = sales.filter((t) => t.kind === "refund" && t.status !== "failure" && t.provider !== "gift_card").reduce((s, t) => s + t.amount, 0);
  const providerRefundable = Math.max(0, providerSales.reduce((s, t) => s + t.amount, 0) - providerRefunded);
  const toProvider = Math.min(amount, providerRefundable);
  const toGiftCards = amount - toProvider;

  const refundId = uuidv7();
  const sale = providerSales[0];
  let providerTx: { id: string; status: "pending" | "success" | "failure"; provider: string; mode: "test" | "live" | null } | null = null;
  if (toProvider > 0) {
    const online = sale && !sale.providerReference?.startsWith("manual:") && sale.mode;
    if (online) {
      const provider = await loadProvider(deps, { storeId, kind: "payment", provider: sale.provider, mode: sale.mode! });
      if (!provider) throw new AppError("conflict", `${sale.provider} is not configured any more; refund it in the provider's dashboard`);
      try {
        const t = await provider.refund(sale.providerReference!, toProvider, data.reason, refundId);
        if (t.status === "failure") throw new AppError("provider_error", "The payment provider declined the refund");
        providerTx = { id: t.id, status: t.status, provider: sale.provider, mode: sale.mode };
      } catch (err) {
        if (err instanceof AppError) throw err;
        throw new AppError("provider_error", err instanceof Error ? err.message : "Refund failed");
      }
    } else {
      providerTx = { id: `manual:${refundId}`, status: "success", provider: sale?.provider ?? order.paymentProvider ?? "manual", mode: order.paymentMode };
    }
  }

  return deps.db.transaction(async (tx) => {
    const locked = await lockOrder(tx, storeId, orderId);
    const status = providerTx?.status ?? "success";
    let transactionId: string | null = null;
    if (providerTx) {
      const [row] = await tx
        .insert(transactions)
        .values({ storeId, orderId, kind: "refund", status: providerTx.status, amount: toProvider, currency: order.currency, provider: providerTx.provider, mode: providerTx.mode, providerReference: providerTx.id, parentId: sale?.id ?? null, createdBy: actor.id ?? null, processedAt: now(deps) })
        .onConflictDoNothing()
        .returning({ id: transactions.id });
      transactionId = row?.id ?? null;
    }
    if (toGiftCards > 0) {
      const credited = await refundToGiftCards(tx, storeId, orderId, toGiftCards, { type: "staff", id: actor.id ?? null });
      if (credited < toGiftCards) throw new AppError("validation_failed", `Only ${formatMinor(credited + toProvider, order.currency)} can be refunded`);
      const [row] = await tx
        .insert(transactions)
        .values({ storeId, orderId, kind: "refund", status: "success", amount: toGiftCards, currency: order.currency, provider: "gift_card", mode: "live", providerReference: `gift_card:${refundId}`, method: "gift_card", createdBy: actor.id ?? null, processedAt: now(deps) })
        .returning({ id: transactions.id });
      transactionId ??= row!.id;
    }
    await tx.insert(refunds).values({
      id: refundId,
      storeId,
      orderId,
      amount,
      shippingAmount: Math.min(calc.shipping, amount),
      status,
      returnId: data.returnId ?? null,
      currency: order.currency,
      reason: data.reason ?? null,
      restock: data.lines.some((l) => l.restock),
      transactionId,
      createdBy: actor.id ?? null,
    });

    const restock: QuantityChange[] = [];
    for (const l of data.lines) {
      const line = lines.find((x) => x.id === l.orderLineId)!;
      const [fresh] = await tx.select().from(orderLines).where(eq(orderLines.id, line.id)).for("update");
      const cur = fresh as LineRow;
      if (l.quantity > cur.quantity - cur.refundedQuantity) throw new AppError("conflict", `Too many of ${cur.title} refunded`);
      await tx.insert(refundLines).values({ storeId, refundId, orderLineId: cur.id, quantity: l.quantity, restock: l.restock });
      // Refunds take unfulfilled units first: those are still committed at the reserved location.
      const openUnits = cur.quantity - cur.fulfilledQuantity - Math.min(cur.refundedQuantity, cur.quantity - cur.fulfilledQuantity);
      const fromOpen = Math.min(l.quantity, Math.max(0, openUnits));
      const fromShipped = l.quantity - fromOpen;
      let restocked = 0;
      if (cur.inventoryItemId && cur.locationId && locked.inventoryState === "reserved" && fromOpen > 0) {
        // Unshipped units: release the reservation (back to available only when restocking).
        restock.push({ inventoryItemId: cur.inventoryItemId, locationId: cur.locationId, quantity: "committed", delta: -fromOpen });
        if (l.restock) {
          restock.push({ inventoryItemId: cur.inventoryItemId, locationId: l.locationId ?? cur.locationId, quantity: "available", delta: fromOpen });
          restocked += fromOpen;
        }
      }
      if (l.restock && !data.returnId && cur.inventoryItemId && fromShipped > 0) {
        // Shipped units the merchant has back: return them to available.
        const loc = l.locationId ?? cur.locationId;
        const units = Math.min(fromShipped, cur.quantity - cur.restockedQuantity - restocked);
        if (loc && units > 0) {
          restock.push({ inventoryItemId: cur.inventoryItemId, locationId: loc, quantity: "available", delta: units });
          restocked += units;
        }
      }
      // Shipped units refunded outside a return: restocked ones came back, the rest were kept.
      const cameBack = !data.returnId && l.restock ? fromShipped : 0;
      const kept = !data.returnId && !l.restock ? fromShipped : 0;
      await tx
        .update(orderLines)
        .set({ refundedQuantity: cur.refundedQuantity + l.quantity, restockedQuantity: cur.restockedQuantity + restocked, returnedQuantity: cur.returnedQuantity + cameBack, keptQuantity: cur.keptQuantity + kept })
        .where(eq(orderLines.id, cur.id));
    }
    if (restock.length) {
      const productIds = await applyInventoryChanges(tx, actor, storeId, restock, "restock", `Refund on ${order.name}`);
      if (productIds.length) await refreshProducts(tx, storeId, productIds);
    }
    await syncRefundTotals(tx, locked);
    await recomputeFulfillmentStatus(tx, locked);
    const money = formatMinor(amount, order.currency);
    await addOrderEvent(tx, storeId, orderId, "refunded", `Refunded ${money}${data.reason ? `: ${data.reason}` : ""}${status === "pending" ? " (pending at provider)" : ""}${toGiftCards > 0 ? ` (${formatMinor(toGiftCards, order.currency)} to gift card)` : ""}`, staffActor(actor), {
      refundId,
      status,
    });
    await refreshCustomerStats(tx, locked.customerId);
    await enqueueEvent(tx, { storeId, type: "order.refunded", payload: { orderId, refundId, notify: data.notify } });
    await writeAudit(tx, actor, { storeId, action: "order.refunded", resourceType: "order", resourceId: orderId, metadata: { amount, status } });
    return { refundId, status, amount };
  });
}

/**
 * A refund reported by the provider (webhook or our own call's later confirmation). A pending refund
 * we created becomes success/failure; a refund made in the provider's dashboard is recorded once.
 */
export async function applyProviderRefund(
  tx: Executor,
  deps: CoreDeps,
  order: OrderRow,
  refund: { id: string; amount: number; currency: string },
  provider: string,
  mode: "test" | "live" | null,
  outcome: "success" | "failure" = "success",
) {
  const [existing] = await tx
    .select()
    .from(transactions)
    .where(and(eq(transactions.storeId, order.storeId), eq(transactions.provider, provider), eq(transactions.kind, "refund"), eq(transactions.providerReference, refund.id)))
    .for("update");
  if (existing) {
    if (existing.status !== "pending") return { changed: false };
    await tx.update(transactions).set({ status: outcome, processedAt: now(deps), errorMessage: outcome === "failure" ? "Refund failed at the provider" : null }).where(eq(transactions.id, existing.id));
    const [r] = await tx.update(refunds).set({ status: outcome }).where(eq(refunds.transactionId, existing.id)).returning({ id: refunds.id });
    await syncRefundTotals(tx, order);
    const money = formatMinor(existing.amount, existing.currency);
    await addOrderEvent(tx, order.storeId, order.id, outcome === "success" ? "refund_succeeded" : "refund_failed", outcome === "success" ? `Refund of ${money} confirmed by ${provider}` : `Refund of ${money} failed at ${provider}`, { type: "provider" }, { refundId: r?.id });
    await refreshCustomerStats(tx, order.customerId);
    return { changed: true };
  }
  if (outcome === "failure") return { changed: false };
  const [inserted] = await tx
    .insert(transactions)
    .values({ storeId: order.storeId, orderId: order.id, kind: "refund", status: "success", amount: refund.amount, currency: refund.currency, provider, mode, providerReference: refund.id, processedAt: now(deps) })
    .onConflictDoNothing()
    .returning({ id: transactions.id });
  if (!inserted) return { changed: false };
  const [row] = await tx
    .insert(refunds)
    .values({ storeId: order.storeId, orderId: order.id, amount: refund.amount, currency: refund.currency, status: "success", reason: "Refunded at the payment provider", transactionId: inserted.id })
    .returning({ id: refunds.id });
  await syncRefundTotals(tx, order);
  await addOrderEvent(tx, order.storeId, order.id, "refunded", `Refund of ${formatMinor(refund.amount, refund.currency)} recorded from ${provider}`, { type: "provider" });
  await refreshCustomerStats(tx, order.customerId);
  await enqueueEvent(tx, { storeId: order.storeId, type: "order.refunded", payload: { orderId: order.id, refundId: row!.id, notify: true } });
  return { changed: true };
}
