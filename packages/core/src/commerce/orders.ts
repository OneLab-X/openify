import { hmacSha256Hex, safeEqual } from "@shopkit/crypto";
import {
  and,
  asc,
  carts,
  checkouts,
  desc,
  eq,
  inArray,
  inventoryLevels,
  isNotNull,
  isNull,
  locations,
  lte,
  orderEvents,
  orderLines,
  orderSequences,
  orders,
  productVariants,
  products,
  providerCredentials,
  refundLines,
  refunds,
  sql,
  transactions,
  uuidv7,
  UUID_RE,
  type Executor,
} from "@shopkit/db";
import type { PaymentResult } from "@shopkit/providers";
import { z } from "zod";
import { writeAudit } from "../audit.js";
import { applyInventoryChanges, type QuantityChange } from "../catalog/inventory.js";
import { mediaByIds, mediaView } from "../catalog/media-view.js";
import { refreshProducts } from "../catalog/refresh.js";
import { loadProvider } from "../credentials.js";
import type { Actor, CoreDeps } from "../deps.js";
import { now, SYSTEM } from "../deps.js";
import { AppError, notFound } from "../errors.js";
import { enqueueEvent } from "../outbox.js";
import { getSetting } from "../settings.js";
import { ensureCustomerForOrder, refreshCustomerStats } from "./customers.js";
import { recordDiscountUsage } from "./discounts.js";
import type { Pricing } from "./pricing.js";

export type OrderRow = typeof orders.$inferSelect;
type EventActor = { type: "staff" | "customer" | "system" | "provider" | "api_key"; id?: string | null };

// ── Signed order-status links (thank-you / status page without login) ──────
export function orderStatusToken(deps: Pick<CoreDeps, "runtime">, orderId: string): string {
  return `${orderId}.${hmacSha256Hex(deps.runtime.signingSecret, `order-status:${orderId}`).slice(0, 32)}`;
}

export function verifyOrderStatusToken(deps: Pick<CoreDeps, "runtime">, token: string): string | null {
  const [id, sig] = token.split(".");
  if (!id || !sig || !UUID_RE.test(id)) return null;
  return safeEqual(orderStatusToken(deps, id), token) ? id : null;
}

export const orderStatusUrl = (deps: Pick<CoreDeps, "runtime">, orderId: string) => `${deps.runtime.publicUrl}/orders/${orderStatusToken(deps, orderId)}`;

// ── Numbering ────────────────────────────────────────────────────────────────
/** Per-store sequences; the row lock serialises concurrent placements. */
export async function nextNumber(tx: Executor, storeId: string, kind: "order" | "draft"): Promise<number> {
  await tx.insert(orderSequences).values({ storeId }).onConflictDoNothing();
  const col = kind === "order" ? sql`next_order` : sql`next_draft`;
  const { rows } = await tx.execute<{ n: number }>(sql`update ${orderSequences} set ${col} = ${col} + 1 where store_id = ${storeId} returning ${col} - 1 as n`);
  return rows[0]!.n;
}

export async function addOrderEvent(tx: Executor, storeId: string, orderId: string, type: string, message: string, actor: EventActor, data: Record<string, unknown> = {}) {
  const [row] = await tx
    .insert(orderEvents)
    .values({ storeId, orderId, type, message, data, actorType: actor.type, actorId: actor.id ?? null })
    .returning({ id: orderEvents.id });
  return row!.id;
}

const staffActor = (a: Actor): EventActor => ({ type: a.type === "api_key" ? "api_key" : a.type === "staff" ? "staff" : "system", id: a.id ?? null });

export function formatMinor(amount: number, currency: string): string {
  try {
    const digits = new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
    return new Intl.NumberFormat("en", { style: "currency", currency }).format(amount / 10 ** digits);
  } catch {
    return `${currency} ${amount}`;
  }
}

export async function lockOrder(tx: Executor, storeId: string, orderId: string): Promise<OrderRow> {
  const [row] = await tx.select().from(orders).where(and(eq(orders.storeId, storeId), eq(orders.id, orderId))).for("update");
  if (!row) throw notFound("Order");
  return row;
}

// ── Lines and inventory ──────────────────────────────────────────────────────
export async function writeOrderLines(tx: Executor, storeId: string, orderId: string, pricing: Pricing) {
  await tx.delete(orderLines).where(eq(orderLines.orderId, orderId));
  if (pricing.lines.length === 0) return;
  await tx.insert(orderLines).values(
    pricing.lines.map((l, i) => ({
      storeId,
      orderId,
      variantId: l.variantId,
      productId: l.productId,
      inventoryItemId: l.tracked ? l.inventoryItemId : null,
      title: l.title,
      variantTitle: l.variantTitle,
      sku: l.sku,
      hsnCode: l.hsnCode,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      compareAtPrice: l.compareAtPrice,
      discountAmount: l.discountAmount,
      taxAmount: l.taxAmount,
      taxLines: l.taxLines,
      requiresShipping: l.requiresShipping,
      taxable: l.taxable,
      attributes: l.attributes,
      position: i,
    })),
  );
}

export function totalsFromPricing(p: Pricing) {
  return {
    currency: p.currency,
    subtotal: p.subtotal,
    discountTotal: p.discountTotal,
    shippingTotal: p.shippingTotal,
    taxTotal: p.taxTotal,
    total: p.total,
    taxesIncluded: p.taxesIncluded,
    taxLines: p.taxLines,
    discountApplications: p.discount.application ? [p.discount.application] : [],
    shippingLine: p.shippingLine,
  };
}

async function touchProducts(tx: Executor, storeId: string, productIds: string[]) {
  const ids = [...new Set(productIds)];
  if (ids.length === 0) return;
  await refreshProducts(tx, storeId, ids);
  const rows = await tx.select({ id: products.id, handle: products.handle }).from(products).where(inArray(products.id, ids));
  for (const r of rows) await enqueueEvent(tx, { storeId, type: "product.updated", payload: { productId: r.id, handle: r.handle, reason: "inventory" } });
}

/**
 * Moves each tracked line's quantity from `available` to `committed` (Shopify semantics: stock is
 * decremented once, when the order is created). Picks the default location when it has enough,
 * else the location with the most stock. Without `force`, "deny" variants must have the stock.
 */
export async function reserveInventory(tx: Executor, storeId: string, order: OrderRow, opts: { force?: boolean } = {}) {
  if (order.inventoryState === "reserved") return;
  const lines = await tx
    .select({ line: orderLines, policy: productVariants.inventoryPolicy })
    .from(orderLines)
    .leftJoin(productVariants, eq(productVariants.id, orderLines.variantId))
    .where(and(eq(orderLines.orderId, order.id), isNotNull(orderLines.inventoryItemId)));
  const changes: QuantityChange[] = [];
  for (const { line, policy } of lines) {
    const levels = await tx
      .select({ locationId: inventoryLevels.locationId, available: inventoryLevels.available, isDefault: locations.isDefault })
      .from(inventoryLevels)
      .innerJoin(locations, and(eq(locations.id, inventoryLevels.locationId), eq(locations.active, true)))
      .where(eq(inventoryLevels.inventoryItemId, line.inventoryItemId!))
      .orderBy(desc(locations.isDefault), desc(inventoryLevels.available))
      .for("update");
    const enough = levels.find((l) => l.available >= line.quantity);
    let target = enough?.locationId;
    if (!target) {
      if (policy === "deny" && !opts.force) throw new AppError("conflict", `${line.title} ${line.variantTitle ? `(${line.variantTitle}) ` : ""}is out of stock`);
      target = levels[0]?.locationId ?? (await defaultLocationId(tx, storeId));
    }
    changes.push(
      { inventoryItemId: line.inventoryItemId!, locationId: target, quantity: "available", delta: -line.quantity },
      { inventoryItemId: line.inventoryItemId!, locationId: target, quantity: "committed", delta: line.quantity },
    );
    await tx.update(orderLines).set({ locationId: target }).where(eq(orderLines.id, line.id));
  }
  const productIds = await applyInventoryChanges(tx, SYSTEM, storeId, changes, "order", `Order ${order.name ?? order.id}`);
  await tx.update(orders).set({ inventoryState: "reserved" }).where(eq(orders.id, order.id));
  order.inventoryState = "reserved";
  await touchProducts(tx, storeId, productIds);
}

async function defaultLocationId(tx: Executor, storeId: string) {
  const [loc] = await tx.select({ id: locations.id }).from(locations).where(eq(locations.storeId, storeId)).orderBy(desc(locations.isDefault), asc(locations.createdAt)).limit(1);
  if (!loc) throw new AppError("conflict", "Add a location before selling tracked products");
  return loc.id;
}

/**
 * Undoes a reservation. `restock` returns the quantity to `available` (expired unpaid order, or a
 * cancel with restock); without it only `committed` drops (the goods are treated as gone).
 */
export async function releaseInventory(tx: Executor, storeId: string, order: OrderRow, opts: { restock: boolean; note: string }) {
  if (order.inventoryState !== "reserved") return;
  const lines = await tx.select().from(orderLines).where(and(eq(orderLines.orderId, order.id), isNotNull(orderLines.inventoryItemId), isNotNull(orderLines.locationId)));
  const changes: QuantityChange[] = [];
  for (const l of lines) {
    const qty = l.quantity - l.restockedQuantity;
    if (qty <= 0) continue;
    changes.push({ inventoryItemId: l.inventoryItemId!, locationId: l.locationId!, quantity: "committed", delta: -qty });
    if (opts.restock) {
      changes.push({ inventoryItemId: l.inventoryItemId!, locationId: l.locationId!, quantity: "available", delta: qty });
      await tx.update(orderLines).set({ restockedQuantity: l.quantity }).where(eq(orderLines.id, l.id));
    }
  }
  const productIds = await applyInventoryChanges(tx, SYSTEM, storeId, changes, opts.restock ? "restock" : "order", opts.note);
  await tx.update(orders).set({ inventoryState: "released" }).where(eq(orders.id, order.id));
  order.inventoryState = "released";
  await touchProducts(tx, storeId, productIds);
}

/** Delayed `inventory-release` job: frees stock held by an order that was never paid. */
export async function releaseExpiredReservation(deps: CoreDeps, storeId: string, orderId: string): Promise<boolean> {
  return deps.db.transaction(async (tx) => {
    const order = await lockOrder(tx, storeId, orderId);
    if (order.placedAt || order.inventoryState !== "reserved" || !order.reservationExpiresAt || order.reservationExpiresAt > now(deps)) return false;
    await releaseInventory(tx, storeId, order, { restock: true, note: `Unpaid checkout ${order.id} expired` });
    await addOrderEvent(tx, storeId, order.id, "reservation_released", "Reserved stock released: payment not received in time", { type: "system" });
    return true;
  });
}

/** Safety net for lost delayed jobs: releases every expired reservation. */
export async function sweepExpiredReservations(deps: CoreDeps): Promise<number> {
  const due = await deps.db
    .select({ id: orders.id, storeId: orders.storeId })
    .from(orders)
    .where(and(isNull(orders.placedAt), eq(orders.inventoryState, "reserved"), lte(orders.reservationExpiresAt, now(deps))))
    .limit(200);
  let released = 0;
  for (const o of due) if (await releaseExpiredReservation(deps, o.storeId, o.id)) released++;
  return released;
}

// ── Placement and payment state ──────────────────────────────────────────────
function financialFor(o: Pick<OrderRow, "amountPaid" | "amountRefunded" | "total" | "financialStatus">): OrderRow["financialStatus"] {
  if (o.amountRefunded > 0) return o.amountRefunded >= o.amountPaid ? "refunded" : "partially_refunded";
  if (o.amountPaid > 0) return o.amountPaid >= o.total ? "paid" : "partially_paid";
  return o.financialStatus === "authorized" ? "authorized" : o.financialStatus === "voided" ? "voided" : "pending";
}

/**
 * Turns a checkout's order into a real order: number, customer record, discount usage, completed
 * cart, and the `order.placed` outbox event (confirmation email + merchant alert). Idempotent.
 */
export async function placeOrder(tx: Executor, deps: CoreDeps, order: OrderRow, opts: { paid: boolean; actor: EventActor }): Promise<boolean> {
  if (order.placedAt) return false;
  const at = now(deps);
  const cfg = await getSetting(tx, order.storeId, "checkout.config");
  const number = await nextNumber(tx, order.storeId, "order");
  const name = `${cfg.orderPrefix}${number}`;
  const customerId =
    order.customerId ??
    (order.email
      ? await ensureCustomerForOrder(tx, order.storeId, { email: order.email, phone: order.phone, currency: order.currency, marketingConsent: order.marketingConsent, address: order.shippingAddress ?? order.billingAddress, at })
      : null);
  await tx.update(orders).set({ number, name, placedAt: at, customerId, reservationExpiresAt: null }).where(eq(orders.id, order.id));
  Object.assign(order, { number, name, placedAt: at, customerId, reservationExpiresAt: null });
  for (const d of order.discountApplications) {
    if (d.discountId) await recordDiscountUsage(tx, order.storeId, { discountId: d.discountId, codeId: null, orderId: order.id, email: order.email, customerId });
  }
  if (order.checkoutId) {
    const [co] = await tx.update(checkouts).set({ status: "completed", completedAt: at, customerId }).where(eq(checkouts.id, order.checkoutId)).returning({ cartId: checkouts.cartId });
    if (co) await tx.update(carts).set({ completedAt: at }).where(eq(carts.id, co.cartId));
  }
  await refreshCustomerStats(tx, customerId);
  await addOrderEvent(tx, order.storeId, order.id, "placed", `Order ${name} placed`, opts.actor, { paid: opts.paid });
  await enqueueEvent(tx, { storeId: order.storeId, type: "order.placed", payload: { orderId: order.id, paid: opts.paid } });
  return true;
}

export interface PaymentSource {
  provider: string;
  mode: "test" | "live" | null;
  via: "return" | "webhook" | "staff";
  eventId?: string;
}

/**
 * Applies a verified provider result to an order, idempotently: the transaction row is unique per
 * (provider, kind, provider payment id), so a replayed webhook or a return + webhook pair records
 * the payment once, places the order once, and enqueues the confirmation once.
 */
export async function applyPaymentResult(tx: Executor, deps: CoreDeps, order: OrderRow, result: PaymentResult, source: PaymentSource): Promise<{ changed: boolean }> {
  const actor: EventActor = { type: source.via === "staff" ? "staff" : "provider" };
  const money = formatMinor(result.amount, result.currency);
  if (result.status === "captured" || result.status === "authorized" || result.status === "partially_refunded" || result.status === "refunded") {
    const kind = result.status === "authorized" ? "authorization" : "sale";
    const reference = result.providerPaymentId ?? `${result.providerOrderId}:${kind}`;
    const inserted = await tx
      .insert(transactions)
      .values({
        storeId: order.storeId,
        orderId: order.id,
        kind,
        status: "success",
        amount: result.amount,
        currency: result.currency,
        provider: source.provider,
        mode: source.mode,
        providerReference: reference,
        providerOrderId: result.providerOrderId,
        method: result.method ?? null,
        processedAt: now(deps),
      })
      .onConflictDoNothing()
      .returning({ id: transactions.id });
    if (inserted.length === 0) return { changed: false };
    if (result.currency !== order.currency || (kind === "sale" && result.amount !== order.total)) {
      await addOrderEvent(tx, order.storeId, order.id, "payment_mismatch", `Payment of ${money} does not match the order total ${formatMinor(order.total, order.currency)}`, actor, {
        amount: result.amount,
        currency: result.currency,
      });
    }
    const amountPaid = kind === "sale" && result.currency === order.currency ? order.amountPaid + result.amount : order.amountPaid;
    const financialStatus = kind === "authorization" && amountPaid === 0 ? "authorized" : financialFor({ ...order, amountPaid });
    await tx.update(orders).set({ amountPaid, financialStatus }).where(eq(orders.id, order.id));
    const wasPlaced = !!order.placedAt;
    Object.assign(order, { amountPaid, financialStatus });
    await addOrderEvent(tx, order.storeId, order.id, kind === "sale" ? "payment_captured" : "payment_authorized", `${kind === "sale" ? "Payment of" : "Authorized"} ${money} via ${source.provider}${source.via === "return" ? "" : ` (${source.via})`}`, actor, {
      transactionId: inserted[0]!.id,
      providerPaymentId: result.providerPaymentId,
    });
    if (!wasPlaced) {
      if (order.status === "cancelled") {
        await addOrderEvent(tx, order.storeId, order.id, "payment_after_cancel", "Payment arrived for a cancelled checkout; refund it or contact the customer", actor);
      } else {
        // Paid after the reservation expired: take the stock again even if it oversells.
        if (order.inventoryState !== "reserved") await reserveInventory(tx, order.storeId, order, { force: true });
        await placeOrder(tx, deps, order, { paid: true, actor });
      }
    } else if (kind === "sale") {
      await refreshCustomerStats(tx, order.customerId);
      await enqueueEvent(tx, { storeId: order.storeId, type: "order.paid", payload: { orderId: order.id } });
    }
    return { changed: true };
  }
  if (result.status === "failed") {
    const reference = result.providerPaymentId ?? `${result.providerOrderId ?? order.id}:failed:${source.eventId ?? "return"}`;
    const inserted = await tx
      .insert(transactions)
      .values({
        storeId: order.storeId,
        orderId: order.id,
        kind: "sale",
        status: "failure",
        amount: result.amount,
        currency: result.currency,
        provider: source.provider,
        mode: source.mode,
        providerReference: `failed:${reference}`,
        providerOrderId: result.providerOrderId,
        method: result.method ?? null,
        errorMessage: result.errorDescription ?? null,
        processedAt: now(deps),
      })
      .onConflictDoNothing()
      .returning({ id: transactions.id });
    if (inserted.length === 0) return { changed: false };
    await addOrderEvent(tx, order.storeId, order.id, "payment_failed", `Payment failed${result.errorDescription ? `: ${result.errorDescription}` : ""}`, actor);
    if (!order.placedAt && order.email) await enqueueEvent(tx, { storeId: order.storeId, type: "order.payment_failed", payload: { orderId: order.id } });
    return { changed: true };
  }
  return { changed: false };
}

/** A refund that happened at the provider (dashboard or our own call), recorded once by refund id. */
export async function applyProviderRefund(tx: Executor, deps: CoreDeps, order: OrderRow, refund: { id: string; amount: number; currency: string }, provider: string, mode: "test" | "live" | null) {
  const inserted = await tx
    .insert(transactions)
    .values({
      storeId: order.storeId,
      orderId: order.id,
      kind: "refund",
      status: "success",
      amount: refund.amount,
      currency: refund.currency,
      provider,
      mode,
      providerReference: refund.id,
      processedAt: now(deps),
    })
    .onConflictDoNothing()
    .returning({ id: transactions.id });
  if (inserted.length === 0) return { changed: false };
  const amountRefunded = order.amountRefunded + refund.amount;
  const financialStatus = financialFor({ ...order, amountRefunded });
  await tx.update(orders).set({ amountRefunded, financialStatus }).where(eq(orders.id, order.id));
  Object.assign(order, { amountRefunded, financialStatus });
  const [row] = await tx
    .insert(refunds)
    .values({ storeId: order.storeId, orderId: order.id, amount: refund.amount, currency: refund.currency, reason: "Refunded at the payment provider", transactionId: inserted[0]!.id })
    .returning({ id: refunds.id });
  await addOrderEvent(tx, order.storeId, order.id, "refunded", `Refund of ${formatMinor(refund.amount, refund.currency)} recorded from ${provider}`, { type: "provider" });
  await refreshCustomerStats(tx, order.customerId);
  await enqueueEvent(tx, { storeId: order.storeId, type: "order.refunded", payload: { orderId: order.id, refundId: row!.id, notify: true } });
  return { changed: true };
}

// ── Staff actions ────────────────────────────────────────────────────────────
export const markPaidInput = z.object({ note: z.string().trim().max(500).optional() });

/** Records a manual payment (COD collected, bank transfer received, draft order paid). */
export async function markOrderPaid(deps: CoreDeps, actor: Actor, storeId: string, orderId: string, input: z.input<typeof markPaidInput> = {}) {
  const { note } = markPaidInput.parse(input);
  await deps.db.transaction(async (tx) => {
    const order = await lockOrder(tx, storeId, orderId);
    if (!order.placedAt) throw new AppError("conflict", "This checkout has not been placed");
    if (order.status === "cancelled") throw new AppError("conflict", "The order is cancelled");
    const due = order.total - order.amountPaid;
    if (due <= 0) throw new AppError("conflict", "The order is already paid");
    const [txRow] = await tx
      .insert(transactions)
      .values({
        storeId,
        orderId,
        kind: "sale",
        status: "success",
        amount: due,
        currency: order.currency,
        provider: order.paymentProvider ?? "manual",
        mode: order.paymentMode,
        providerReference: `manual:${uuidv7()}`,
        method: "manual",
        createdBy: actor.id ?? null,
        processedAt: now(deps),
      })
      .returning({ id: transactions.id });
    const amountPaid = order.amountPaid + due;
    await tx.update(orders).set({ amountPaid, financialStatus: financialFor({ ...order, amountPaid }) }).where(eq(orders.id, orderId));
    await addOrderEvent(tx, storeId, orderId, "marked_paid", `Marked as paid (${formatMinor(due, order.currency)})${note ? `: ${note}` : ""}`, staffActor(actor), { transactionId: txRow!.id });
    await refreshCustomerStats(tx, order.customerId);
    await enqueueEvent(tx, { storeId, type: "order.paid", payload: { orderId } });
    await writeAudit(tx, actor, { storeId, action: "order.marked_paid", resourceType: "order", resourceId: orderId });
  });
}

export const refundInput = z.object({
  amount: z.number().int().min(1),
  reason: z.string().trim().max(500).optional(),
  lines: z.array(z.object({ orderLineId: z.uuid(), quantity: z.number().int().min(1), restock: z.boolean().default(true) })).max(250).default([]),
  notify: z.boolean().default(true),
});
export type RefundInput = z.input<typeof refundInput>;

/**
 * Refunds through the provider that took the payment (or records a manual refund for COD/bank
 * transfer). The provider call happens before anything is written, keyed by our refund id.
 */
export async function refundOrder(deps: CoreDeps, actor: Actor, storeId: string, orderId: string, input: RefundInput) {
  const data = refundInput.parse(input);
  const [order] = await deps.db.select().from(orders).where(and(eq(orders.storeId, storeId), eq(orders.id, orderId)));
  if (!order?.placedAt) throw notFound("Order");
  const refundable = order.amountPaid - order.amountRefunded;
  if (data.amount > refundable) throw new AppError("validation_failed", `You can refund at most ${formatMinor(refundable, order.currency)}`);
  const lines = data.lines.length ? await deps.db.select().from(orderLines).where(and(eq(orderLines.orderId, orderId), inArray(orderLines.id, data.lines.map((l) => l.orderLineId)))) : [];
  for (const l of data.lines) {
    const line = lines.find((x) => x.id === l.orderLineId);
    if (!line) throw notFound("Order line");
    if (l.quantity > line.quantity - line.refundedQuantity) throw new AppError("validation_failed", `Too many of ${line.title} refunded`);
  }

  const refundId = uuidv7();
  const [sale] = await deps.db
    .select()
    .from(transactions)
    .where(and(eq(transactions.orderId, orderId), eq(transactions.kind, "sale"), eq(transactions.status, "success")))
    .orderBy(desc(transactions.amount))
    .limit(1);
  let providerTx: { id: string; status: "pending" | "success" | "failure"; provider: string; mode: "test" | "live" | null };
  const online = sale && !sale.providerReference?.startsWith("manual:") && sale.mode;
  if (online) {
    const provider = await loadProvider(deps, { storeId, kind: "payment", provider: sale.provider, mode: sale.mode! });
    if (!provider) throw new AppError("conflict", `${sale.provider} is not configured any more; refund it in the provider's dashboard`);
    try {
      const t = await provider.refund(sale.providerReference!, data.amount, data.reason, refundId);
      if (t.status === "failure") throw new AppError("provider_error", "The payment provider declined the refund");
      providerTx = { id: t.id, status: t.status, provider: sale.provider, mode: sale.mode };
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw new AppError("provider_error", err instanceof Error ? err.message : "Refund failed");
    }
  } else {
    providerTx = { id: `manual:${refundId}`, status: "success", provider: sale?.provider ?? order.paymentProvider ?? "manual", mode: order.paymentMode };
  }

  return deps.db.transaction(async (tx) => {
    const locked = await lockOrder(tx, storeId, orderId);
    const [txRow] = await tx
      .insert(transactions)
      .values({
        storeId,
        orderId,
        kind: "refund",
        status: providerTx.status,
        amount: data.amount,
        currency: order.currency,
        provider: providerTx.provider,
        mode: providerTx.mode,
        providerReference: providerTx.id,
        parentId: sale?.id ?? null,
        createdBy: actor.id ?? null,
        processedAt: now(deps),
      })
      .onConflictDoNothing()
      .returning({ id: transactions.id });
    const amountRefunded = locked.amountRefunded + data.amount;
    await tx.update(orders).set({ amountRefunded, financialStatus: financialFor({ ...locked, amountRefunded }) }).where(eq(orders.id, orderId));
    await tx.insert(refunds).values({
      id: refundId,
      storeId,
      orderId,
      amount: data.amount,
      currency: order.currency,
      reason: data.reason ?? null,
      restock: data.lines.some((l) => l.restock),
      transactionId: txRow?.id ?? null,
      createdBy: actor.id ?? null,
    });
    const restock: QuantityChange[] = [];
    for (const l of data.lines) {
      const line = lines.find((x) => x.id === l.orderLineId)!;
      await tx.insert(refundLines).values({ storeId, refundId, orderLineId: line.id, quantity: l.quantity, restock: l.restock });
      const restockable = l.restock && line.inventoryItemId && line.locationId && locked.inventoryState === "reserved" ? Math.min(l.quantity, line.quantity - line.restockedQuantity) : 0;
      await tx
        .update(orderLines)
        .set({ refundedQuantity: line.refundedQuantity + l.quantity, restockedQuantity: line.restockedQuantity + restockable })
        .where(eq(orderLines.id, line.id));
      if (restockable > 0) {
        restock.push(
          { inventoryItemId: line.inventoryItemId!, locationId: line.locationId!, quantity: "committed", delta: -restockable },
          { inventoryItemId: line.inventoryItemId!, locationId: line.locationId!, quantity: "available", delta: restockable },
        );
      }
    }
    if (restock.length) await touchProducts(tx, storeId, await applyInventoryChanges(tx, actor, storeId, restock, "restock", `Refund on ${order.name}`));
    await addOrderEvent(tx, storeId, orderId, "refunded", `Refunded ${formatMinor(data.amount, order.currency)}${data.reason ? `: ${data.reason}` : ""}${providerTx.status === "pending" ? " (pending at provider)" : ""}`, staffActor(actor), { refundId });
    await refreshCustomerStats(tx, locked.customerId);
    await enqueueEvent(tx, { storeId, type: "order.refunded", payload: { orderId, refundId, notify: data.notify } });
    await writeAudit(tx, actor, { storeId, action: "order.refunded", resourceType: "order", resourceId: orderId, metadata: { amount: data.amount } });
    return { refundId, status: providerTx.status };
  });
}

export const cancelInput = z.object({
  reason: z.enum(["customer", "inventory", "fraud", "declined", "other"]).default("other"),
  restock: z.boolean().default(true),
  refund: z.boolean().default(true),
  notify: z.boolean().default(true),
  staffNote: z.string().trim().max(500).optional(),
});

/** Cancel (Phase 3 item 4): optional full refund of what was paid, restock, customer email. */
export async function cancelOrder(deps: CoreDeps, actor: Actor, storeId: string, orderId: string, input: z.input<typeof cancelInput>) {
  const data = cancelInput.parse(input);
  const [order] = await deps.db.select().from(orders).where(and(eq(orders.storeId, storeId), eq(orders.id, orderId)));
  if (!order?.placedAt) throw notFound("Order");
  if (order.status === "cancelled") throw new AppError("conflict", "The order is already cancelled");
  if (order.fulfillmentStatus !== "unfulfilled") throw new AppError("conflict", "Fulfilled orders cannot be cancelled; refund them instead");
  const refundable = order.amountPaid - order.amountRefunded;
  if (data.refund && refundable > 0) await refundOrder(deps, actor, storeId, orderId, { amount: refundable, reason: "Order cancelled", notify: false });
  await deps.db.transaction(async (tx) => {
    const locked = await lockOrder(tx, storeId, orderId);
    await releaseInventory(tx, storeId, locked, { restock: data.restock, note: `Cancelled ${locked.name}` });
    const financialStatus = locked.amountPaid === 0 ? "voided" : locked.financialStatus;
    await tx
      .update(orders)
      .set({ status: "cancelled", cancelledAt: now(deps), cancelReason: data.reason, financialStatus, closedAt: now(deps) })
      .where(eq(orders.id, orderId));
    await addOrderEvent(tx, storeId, orderId, "cancelled", `Order cancelled (${data.reason})${data.restock ? ", items restocked" : ""}${data.staffNote ? `: ${data.staffNote}` : ""}`, staffActor(actor));
    await refreshCustomerStats(tx, locked.customerId);
    await enqueueEvent(tx, { storeId, type: "order.cancelled", payload: { orderId, notify: data.notify } });
    await writeAudit(tx, actor, { storeId, action: "order.cancelled", resourceType: "order", resourceId: orderId, metadata: { reason: data.reason } });
  });
}

export const orderMetaInput = z.object({
  note: z.string().max(5000).nullish(),
  tags: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
});

export async function updateOrderMeta(deps: CoreDeps, actor: Actor, storeId: string, orderId: string, input: z.input<typeof orderMetaInput>) {
  const d = orderMetaInput.parse(input);
  await deps.db.transaction(async (tx) => {
    await lockOrder(tx, storeId, orderId);
    await tx
      .update(orders)
      .set({
        ...(d.note !== undefined ? { note: d.note?.trim() || null } : {}),
        ...(d.tags !== undefined ? { tags: [...new Set(d.tags.map((t) => t.toLowerCase()))].sort() } : {}),
      })
      .where(eq(orders.id, orderId));
    await writeAudit(tx, actor, { storeId, action: "order.updated", resourceType: "order", resourceId: orderId });
  });
}

export const commentInput = z.object({ message: z.string().trim().min(1).max(5000) });

export async function addOrderComment(deps: CoreDeps, actor: Actor, storeId: string, orderId: string, input: z.input<typeof commentInput>) {
  const { message } = commentInput.parse(input);
  await deps.db.transaction(async (tx) => {
    await lockOrder(tx, storeId, orderId);
    await addOrderEvent(tx, storeId, orderId, "comment", message, staffActor(actor));
  });
}

export const shippingUpdateInput = z.object({
  carrier: z.string().trim().max(100).optional(),
  trackingNumber: z.string().trim().max(100).optional(),
  trackingUrl: z.url().max(1000).optional(),
  message: z.string().trim().max(1000).optional(),
});

/** Sends the "shipping update" email and records it (full fulfillments arrive in Phase 4). */
export async function sendShippingUpdate(deps: CoreDeps, actor: Actor, storeId: string, orderId: string, input: z.input<typeof shippingUpdateInput>) {
  const d = shippingUpdateInput.parse(input);
  await deps.db.transaction(async (tx) => {
    const order = await lockOrder(tx, storeId, orderId);
    if (!order.placedAt || order.status === "cancelled") throw new AppError("conflict", "Only open orders get shipping updates");
    const eventId = await addOrderEvent(tx, storeId, orderId, "shipping_update", `Shipping update sent${d.carrier ? ` (${d.carrier}${d.trackingNumber ? ` ${d.trackingNumber}` : ""})` : ""}`, staffActor(actor), d);
    await enqueueEvent(tx, { storeId, type: "order.shipping_updated", payload: { orderId, eventId, ...d } });
  });
}

// ── Views ────────────────────────────────────────────────────────────────────
export async function orderLinesView(deps: CoreDeps, orderId: string) {
  const lines = await deps.db
    .select({ line: orderLines, handle: products.handle, imageId: sql<string | null>`coalesce(${productVariants.imageMediaId}, ${products.featuredMediaId})` })
    .from(orderLines)
    .leftJoin(productVariants, eq(productVariants.id, orderLines.variantId))
    .leftJoin(products, eq(products.id, orderLines.productId))
    .where(eq(orderLines.orderId, orderId))
    .orderBy(asc(orderLines.position));
  const images = await mediaByIds(deps.db, lines.map((l) => l.imageId).filter((x): x is string => !!x));
  return lines.map(({ line: l, handle, imageId }) => {
    const img = imageId ? images.get(imageId) : undefined;
    return {
      id: l.id,
      variantId: l.variantId,
      productId: l.productId,
      productHandle: handle,
      title: l.title,
      variantTitle: l.variantTitle,
      sku: l.sku,
      hsnCode: l.hsnCode,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      compareAtPrice: l.compareAtPrice,
      discountAmount: l.discountAmount,
      taxAmount: l.taxAmount,
      total: l.unitPrice * l.quantity - l.discountAmount,
      refundedQuantity: l.refundedQuantity,
      restockedQuantity: l.restockedQuantity,
      attributes: l.attributes,
      image: img ? mediaView(deps, img) : null,
    };
  });
}

export function orderSummary(o: OrderRow) {
  return {
    id: o.id,
    name: o.name ?? "",
    number: o.number,
    email: o.email,
    phone: o.phone,
    currency: o.currency,
    subtotal: o.subtotal,
    discountTotal: o.discountTotal,
    shippingTotal: o.shippingTotal,
    taxTotal: o.taxTotal,
    total: o.total,
    taxesIncluded: o.taxesIncluded,
    amountPaid: o.amountPaid,
    amountRefunded: o.amountRefunded,
    taxLines: o.taxLines,
    discountApplications: o.discountApplications.map((d) => ({ code: d.code, title: d.title, kind: d.kind, amount: d.amount })),
    shippingLine: o.shippingLine ? { title: o.shippingLine.title, amount: o.shippingLine.amount, discount: o.shippingLine.discount } : null,
    shippingAddress: o.shippingAddress,
    billingAddress: o.billingAddress,
    status: o.status,
    financialStatus: o.financialStatus,
    fulfillmentStatus: o.fulfillmentStatus,
    paymentProvider: o.paymentProvider,
    placedAt: o.placedAt?.toISOString() ?? null,
    cancelledAt: o.cancelledAt?.toISOString() ?? null,
    cancelReason: o.cancelReason,
  };
}

export async function getOrderAdmin(deps: CoreDeps, storeId: string, orderId: string) {
  const [o] = await deps.db.select().from(orders).where(and(eq(orders.storeId, storeId), eq(orders.id, orderId)));
  if (!o?.placedAt) throw notFound("Order");
  const [lines, txs, events, refundRows] = await Promise.all([
    orderLinesView(deps, orderId),
    deps.db.select().from(transactions).where(eq(transactions.orderId, orderId)).orderBy(asc(transactions.createdAt)),
    deps.db.select().from(orderEvents).where(eq(orderEvents.orderId, orderId)).orderBy(desc(orderEvents.createdAt)),
    deps.db.select().from(refunds).where(eq(refunds.orderId, orderId)).orderBy(asc(refunds.createdAt)),
  ]);
  return {
    ...orderSummary(o),
    note: o.note,
    tags: o.tags,
    attributes: o.attributes,
    customerId: o.customerId,
    paymentMode: o.paymentMode,
    sourceName: o.sourceName,
    marketingConsent: o.marketingConsent,
    statusUrl: orderStatusUrl(deps, o.id),
    lines,
    transactions: txs.map((t) => ({
      id: t.id,
      kind: t.kind,
      status: t.status,
      amount: t.amount,
      currency: t.currency,
      provider: t.provider,
      mode: t.mode,
      providerReference: t.providerReference,
      method: t.method,
      errorMessage: t.errorMessage,
      createdAt: t.createdAt.toISOString(),
    })),
    events: events.map((e) => ({ id: e.id, type: e.type, message: e.message, actorType: e.actorType, actorId: e.actorId, createdAt: e.createdAt.toISOString() })),
    refunds: refundRows.map((r) => ({ id: r.id, amount: r.amount, currency: r.currency, reason: r.reason, restock: r.restock, createdAt: r.createdAt.toISOString() })),
  };
}

export const orderListQuery = z.object({
  q: z.string().trim().max(200).optional(),
  status: z.enum(["open", "closed", "cancelled"]).optional(),
  financialStatus: z.enum(["pending", "authorized", "paid", "partially_paid", "partially_refunded", "refunded", "voided"]).optional(),
  fulfillmentStatus: z.enum(["unfulfilled", "partially_fulfilled", "fulfilled", "returned"]).optional(),
  customerId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(250).default(50),
  cursor: z.string().max(400).optional(),
});

export async function listOrders(deps: CoreDeps, storeId: string, query: z.input<typeof orderListQuery>) {
  const q = orderListQuery.parse(query);
  const like = q.q ? `%${q.q.replace(/[\\%_]/g, "\\$&")}%` : null;
  let after: [string, string] | null = null;
  if (q.cursor) {
    try {
      after = JSON.parse(Buffer.from(q.cursor, "base64url").toString()) as [string, string];
    } catch {
      throw new AppError("bad_request", "Invalid cursor");
    }
  }
  const rows = await deps.db
    .select()
    .from(orders)
    .where(
      and(
        eq(orders.storeId, storeId),
        isNotNull(orders.placedAt),
        q.status ? eq(orders.status, q.status) : undefined,
        q.financialStatus ? eq(orders.financialStatus, q.financialStatus) : undefined,
        q.fulfillmentStatus ? eq(orders.fulfillmentStatus, q.fulfillmentStatus) : undefined,
        q.customerId ? eq(orders.customerId, q.customerId) : undefined,
        like ? sql`(${orders.name} ilike ${like} or ${orders.email} ilike ${like} or concat_ws(' ', ${orders.shippingAddress}->>'firstName', ${orders.shippingAddress}->>'lastName') ilike ${like})` : undefined,
        after ? sql`(${orders.placedAt}, ${orders.id}) < (${after[0]}::timestamptz, ${after[1]}::uuid)` : undefined,
      ),
    )
    .orderBy(desc(orders.placedAt), desc(orders.id))
    .limit(q.limit + 1);
  const pageRows = rows.slice(0, q.limit);
  const counts = pageRows.length
    ? await deps.db
        .select({ orderId: orderLines.orderId, n: sql<number>`sum(${orderLines.quantity})::int` })
        .from(orderLines)
        .where(inArray(orderLines.orderId, pageRows.map((r) => r.id)))
        .groupBy(orderLines.orderId)
    : [];
  const last = pageRows.at(-1);
  return {
    items: pageRows.map((o) => ({
      ...orderSummary(o),
      customerName: [o.shippingAddress?.firstName, o.shippingAddress?.lastName].filter(Boolean).join(" ") || null,
      itemCount: counts.find((c) => c.orderId === o.id)?.n ?? 0,
      tags: o.tags,
    })),
    nextCursor: rows.length > q.limit && last ? Buffer.from(JSON.stringify([last.placedAt!.toISOString(), last.id])).toString("base64url") : null,
  };
}

/** What to tell the customer about paying offline (bank details, COD note); non-secret config only. */
export async function offlineInstructions(deps: CoreDeps, storeId: string, provider: string) {
  const def = deps.registry.get("payment", provider);
  if (def?.paymentFlow !== "offline") return null;
  const [row] = await deps.db
    .select({ config: providerCredentials.config })
    .from(providerCredentials)
    .where(and(eq(providerCredentials.storeId, storeId), eq(providerCredentials.kind, "payment"), eq(providerCredentials.provider, provider)))
    .limit(1);
  const config = (row?.config ?? {}) as { accountDetails?: string; instructions?: string };
  return { title: def.displayName, details: config.accountDetails ?? "", instructions: config.instructions ?? null };
}

/** Customer-facing view (status page, account): no staff notes, timeline or provider ids. */
export async function getOrderPublic(deps: CoreDeps, storeId: string, orderId: string) {
  const [o] = await deps.db.select().from(orders).where(and(eq(orders.storeId, storeId), eq(orders.id, orderId)));
  if (!o) throw notFound("Order");
  const lines = await orderLinesView(deps, orderId);
  const events = await deps.db
    .select()
    .from(orderEvents)
    .where(and(eq(orderEvents.orderId, orderId), inArray(orderEvents.type, ["placed", "payment_captured", "marked_paid", "shipping_update", "cancelled", "refunded"])))
    .orderBy(asc(orderEvents.createdAt));
  return {
    ...orderSummary(o),
    paymentInstructions: o.financialStatus === "pending" && o.paymentProvider ? await offlineInstructions(deps, storeId, o.paymentProvider) : null,
    placed: !!o.placedAt,
    lines,
    shippingUpdates: events
      .filter((e) => e.type === "shipping_update")
      .map((e) => ({ at: e.createdAt.toISOString(), carrier: (e.data.carrier as string | undefined) ?? null, trackingNumber: (e.data.trackingNumber as string | undefined) ?? null, trackingUrl: (e.data.trackingUrl as string | undefined) ?? null, message: (e.data.message as string | undefined) ?? null })),
    timeline: events.filter((e) => e.type !== "shipping_update").map((e) => ({ type: e.type, at: e.createdAt.toISOString() })),
  };
}
