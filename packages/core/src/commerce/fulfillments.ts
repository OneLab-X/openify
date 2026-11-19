import {
  and,
  asc,
  eq,
  fulfillmentLines,
  fulfillments,
  inArray,
  locations,
  orderLines,
  orders,
  productVariants,
  providerCredentials,
  shippingWebhookEvents,
  type Executor,
} from "@shopkit/db";
import { courierTrackingUrl, KNOWN_COURIERS, ProviderError, type ShippingProvider, type TrackingState } from "@shopkit/providers";
import { z } from "zod";
import { writeAudit } from "../audit.js";
import { applyInventoryChanges, type QuantityChange } from "../catalog/inventory.js";
import { refreshProducts } from "../catalog/refresh.js";
import { loadProvider } from "../credentials.js";
import type { Actor, CoreDeps } from "../deps.js";
import { now } from "../deps.js";
import { AppError, notFound } from "../errors.js";
import { enqueueEvent } from "../outbox.js";
import { getStore } from "../stores.js";
import { addOrderEvent, lockOrder, type OrderRow } from "./orders.js";
import { partyFromAddress, shipmentOrigin, toGrams } from "./shipping.js";

/**
 * Fulfillments (Phase 4): partial and multi-location, tracking number/URL, notify toggle. Manual
 * methods are ported from PLS `DeliveryDialog`/`delivery.ts`: a local driver (name, mobile, trip
 * link), a known courier with an AWB (tracking link filled in), or another courier. Carrier
 * adapters (Shiprocket, Delhivery, EasyPost) can create the shipment and label instead.
 *
 * Inventory: fulfilling moves stock out of `committed` at the location it ships from (Shopify
 * semantics: `available` already dropped when the order was created). Shipping from a different
 * location than the one reserved releases the reservation there and takes the stock at the other.
 */
type FulfillmentRow = typeof fulfillments.$inferSelect;
type LineRow = typeof orderLines.$inferSelect;

const staffActor = (a: Actor) => ({ type: a.type === "api_key" ? ("api_key" as const) : a.type === "staff" ? ("staff" as const) : ("system" as const), id: a.id ?? null });

/** Digits only; Indian numbers lose a leading 0/91 to 10 digits (PLS normalizeMobile). */
export function normalizeMobile(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 12 && digits.startsWith("91")) return digits.slice(2);
  if (digits.length === 11 && digits.startsWith("0")) return digits.slice(1);
  return digits;
}

const httpUrl = z
  .string()
  .trim()
  .max(1000)
  .refine((v) => /^https?:\/\//i.test(v) && URL.canParse(v), "Enter a full link starting with https://");

export const fulfillmentInput = z
  .object({
    locationId: z.uuid().nullish(),
    /** Empty = everything still to fulfil. */
    lines: z.array(z.object({ orderLineId: z.uuid(), quantity: z.number().int().min(1) })).max(250).default([]),
    method: z.enum(["local_driver", "courier", "other_courier", "carrier", "pickup", "none"]).default("courier"),
    /** courier: a known courier id; other_courier: the courier's name. */
    carrier: z.string().trim().max(60).nullish(),
    trackingNumber: z.string().trim().max(60).nullish(),
    trackingUrl: httpUrl.nullish().or(z.literal("")),
    driverName: z.string().trim().max(60).nullish(),
    driverMobile: z.string().trim().max(20).nullish(),
    tripLink: httpUrl.nullish().or(z.literal("")),
    /** method "carrier": the shipping provider and (optionally) a quoted rate id. */
    provider: z.string().max(50).nullish(),
    rateId: z.string().max(100).nullish(),
    notifyCustomer: z.boolean().default(true),
  })
  .superRefine((d, ctx) => {
    const issue = (path: string, message: string) => ctx.addIssue({ code: "custom", path: [path], message });
    if (d.method === "local_driver") {
      if ((d.driverName ?? "").length < 2) issue("driverName", "Enter the driver's name");
      const m = normalizeMobile(d.driverMobile ?? "");
      if (m.length < 8 || m.length > 15) issue("driverMobile", "Enter the driver's mobile number");
    }
    if (d.method === "courier" && !KNOWN_COURIERS.some((c) => c.id === d.carrier)) issue("carrier", "Choose a courier");
    if (d.method === "other_courier" && (d.carrier ?? "").length < 2) issue("carrier", "Enter the courier's name");
    if ((d.method === "courier" || d.method === "other_courier") && !/^[A-Za-z0-9-]{4,40}$/.test(d.trackingNumber ?? "")) issue("trackingNumber", "Enter the AWB number (letters and digits)");
    if (d.method === "carrier" && !d.provider) issue("provider", "Choose a carrier");
  });
export type FulfillmentInput = z.input<typeof fulfillmentInput>;

/** Units of a line still to ship: refunds consume unfulfilled units first. */
export function fulfillableQuantity(l: Pick<LineRow, "quantity" | "fulfilledQuantity" | "refundedQuantity" | "giftCard" | "requiresShipping">): number {
  const refundedUnfulfilled = Math.min(l.refundedQuantity, l.quantity - l.fulfilledQuantity);
  return Math.max(0, l.quantity - l.fulfilledQuantity - refundedUnfulfilled);
}

/** Recomputes `fulfillment_status` from the lines (and returns), writing it when it changed. */
export async function recomputeFulfillmentStatus(tx: Executor, order: OrderRow): Promise<OrderRow["fulfillmentStatus"]> {
  const lines = await tx.select().from(orderLines).where(eq(orderLines.orderId, order.id));
  const shippable = lines.filter((l) => !l.giftCard);
  const toShip = shippable.reduce((s, l) => s + l.quantity - Math.min(l.refundedQuantity, l.quantity - l.fulfilledQuantity), 0);
  const shipped = shippable.reduce((s, l) => s + l.fulfilledQuantity, 0);
  const returned = shippable.reduce((s, l) => s + l.returnedQuantity, 0);
  // Fully returned only when every shipped unit came back (kept refunds count as settled).
  let status: OrderRow["fulfillmentStatus"] = "unfulfilled";
  if (shipped > 0 && returned >= shipped) status = "returned";
  else if (shipped > 0) status = shipped >= toShip ? "fulfilled" : "partially_fulfilled";
  if (status !== order.fulfillmentStatus) {
    await tx.update(orders).set({ fulfillmentStatus: status }).where(eq(orders.id, order.id));
    order.fulfillmentStatus = status;
  }
  return status;
}

async function touchInventory(tx: Executor, storeId: string, productIds: string[]) {
  if (productIds.length) await refreshProducts(tx, storeId, [...new Set(productIds)]);
}

async function defaultLocation(tx: Executor, storeId: string): Promise<string | null> {
  const [loc] = await tx.select({ id: locations.id }).from(locations).where(and(eq(locations.storeId, storeId), eq(locations.active, true))).orderBy(asc(locations.createdAt));
  const [def] = await tx.select({ id: locations.id }).from(locations).where(and(eq(locations.storeId, storeId), eq(locations.isDefault, true)));
  return def?.id ?? loc?.id ?? null;
}

function trackingFor(d: z.infer<typeof fulfillmentInput>): { carrier: string | null; trackingNumber: string | null; trackingUrl: string | null } {
  const awb = d.trackingNumber?.trim() || null;
  const given = d.trackingUrl?.trim() || null;
  if (d.method === "courier") return { carrier: d.carrier ?? null, trackingNumber: awb, trackingUrl: given ?? (awb ? courierTrackingUrl(d.carrier!, awb) : null) };
  if (d.method === "other_courier") return { carrier: d.carrier ?? null, trackingNumber: awb, trackingUrl: given };
  if (d.method === "local_driver") return { carrier: null, trackingNumber: null, trackingUrl: given ?? (d.tripLink?.trim() || null) };
  return { carrier: d.carrier ?? null, trackingNumber: awb, trackingUrl: given };
}

export function carrierName(f: Pick<FulfillmentRow, "method" | "carrier" | "provider">): string {
  if (f.method === "local_driver") return "Local delivery";
  if (f.method === "pickup") return "Pickup";
  if (f.method === "courier") return KNOWN_COURIERS.find((c) => c.id === f.carrier)?.name ?? f.carrier ?? "Courier";
  return f.carrier ?? f.provider ?? "Courier";
}

/** Human-readable delivery lines (label, WhatsApp, email), as in PLS `deliveryLines`. */
export function deliveryLines(f: Pick<FulfillmentRow, "method" | "carrier" | "provider" | "trackingNumber" | "trackingUrl" | "driverName" | "driverMobile" | "tripLink">): string[] {
  const lines = [`Delivery partner: ${carrierName(f)}`];
  if (f.method === "local_driver") {
    if (f.driverName) lines.push(`Driver: ${f.driverName}`);
    if (f.driverMobile) lines.push(`Driver's number: ${f.driverMobile.length === 10 ? `+91 ${f.driverMobile}` : `+${f.driverMobile}`}`);
    if (f.tripLink) lines.push(`Live trip: ${f.tripLink}`);
  } else if (f.trackingNumber) lines.push(`AWB number: ${f.trackingNumber}`);
  if (f.trackingUrl && f.trackingUrl !== f.tripLink) lines.push(`Track: ${f.trackingUrl}`);
  return lines;
}

export async function createFulfillment(deps: CoreDeps, actor: Actor, storeId: string, orderId: string, input: FulfillmentInput) {
  const d = fulfillmentInput.parse(input);
  const [order0] = await deps.db.select().from(orders).where(and(eq(orders.storeId, storeId), eq(orders.id, orderId)));
  if (!order0?.placedAt) throw notFound("Order");
  if (order0.status === "cancelled") throw new AppError("conflict", "Cancelled orders cannot be fulfilled");
  const allLines = await deps.db.select().from(orderLines).where(eq(orderLines.orderId, orderId)).orderBy(asc(orderLines.position));
  const wanted = d.lines.length
    ? d.lines
    : allLines.filter((l) => !l.giftCard && fulfillableQuantity(l) > 0).map((l) => ({ orderLineId: l.id, quantity: fulfillableQuantity(l) }));
  if (wanted.length === 0) throw new AppError("conflict", "Nothing left to fulfil on this order");
  for (const w of wanted) {
    const line = allLines.find((l) => l.id === w.orderLineId);
    if (!line || line.giftCard) throw notFound("Order line");
    if (w.quantity > fulfillableQuantity(line)) throw new AppError("validation_failed", `Only ${fulfillableQuantity(line)} of ${line.title} left to fulfil`);
  }
  const locationId = d.locationId ?? (await defaultLocation(deps.db, storeId));

  // Carrier shipments are created before anything is written (the carrier is the slow part).
  let shipment: { provider: string; shipmentId: string; awb: string; carrier: string | null; labelUrl: string | null; trackingUrl: string | null } | null = null;
  if (d.method === "carrier") {
    const provider = await shippingProvider(deps, storeId, d.provider!);
    if (!provider) throw new AppError("conflict", `${d.provider} is not set up; add it in Settings → Shipping`);
    if (!order0.shippingAddress) throw new AppError("validation_failed", "The order has no shipping address");
    const items = wanted.map((w) => {
      const l = allLines.find((x) => x.id === w.orderLineId)!;
      return { name: l.title + (l.variantTitle ? ` - ${l.variantTitle}` : ""), sku: l.sku, quantity: w.quantity, unitPrice: l.unitPrice, hsnCode: l.hsnCode };
    });
    const weight = await linesWeight(deps.db, wanted.map((w) => ({ ...w, variantId: allLines.find((l) => l.id === w.orderLineId)!.variantId })));
    try {
      const s = await provider.createShipment({
        reference: `${orderId}:${allLines.length}:${Date.now()}`,
        orderName: order0.name ?? orderId,
        orderDate: order0.placedAt.toISOString(),
        from: await shipmentOrigin(deps.db, storeId, locationId),
        to: partyFromAddress(order0.shippingAddress, order0.email),
        parcel: { weightGrams: Math.max(weight, 100) },
        declaredValue: items.reduce((s, i) => s + i.unitPrice * i.quantity, 0),
        currency: order0.currency,
        codAmount: order0.financialStatus === "pending" ? order0.total - order0.amountPaid : null,
        rateId: d.rateId ?? order0.shippingLine?.carrierRateId ?? null,
        items,
      });
      shipment = { provider: d.provider!, shipmentId: s.shipmentId, awb: s.awb, carrier: s.carrier ?? null, labelUrl: s.labelUrl ?? null, trackingUrl: s.trackingUrl ?? provider.trackingUrl(s.awb) };
    } catch (err) {
      throw new AppError("provider_error", err instanceof ProviderError || err instanceof Error ? err.message : "The carrier could not create the shipment");
    }
  }

  const tracking = shipment ? { carrier: shipment.carrier, trackingNumber: shipment.awb, trackingUrl: shipment.trackingUrl } : trackingFor(d);
  return deps.db.transaction(async (tx) => {
    const order = await lockOrder(tx, storeId, orderId);
    const lines = await tx.select().from(orderLines).where(eq(orderLines.orderId, orderId)).for("update");
    const count = (await tx.select({ id: fulfillments.id }).from(fulfillments).where(eq(fulfillments.orderId, orderId))).length;
    const [f] = await tx
      .insert(fulfillments)
      .values({
        storeId,
        orderId,
        name: `${order.name ?? "Order"}-F${count + 1}`,
        locationId,
        status: d.method === "pickup" ? "pending" : "shipped",
        method: d.method,
        ...tracking,
        driverName: d.method === "local_driver" ? d.driverName! : null,
        driverMobile: d.method === "local_driver" ? normalizeMobile(d.driverMobile!) : null,
        tripLink: d.method === "local_driver" ? d.tripLink || null : null,
        provider: shipment?.provider ?? null,
        providerShipmentId: shipment?.shipmentId ?? null,
        labelUrl: shipment?.labelUrl ?? null,
        notifyCustomer: d.notifyCustomer,
        createdBy: actor.type === "staff" ? (actor.id ?? null) : null,
      })
      .returning();

    const changes: QuantityChange[] = [];
    for (const w of wanted) {
      const line = lines.find((l) => l.id === w.orderLineId)!;
      if (w.quantity > fulfillableQuantity(line)) throw new AppError("conflict", `Only ${fulfillableQuantity(line)} of ${line.title} left to fulfil`);
      await tx.insert(fulfillmentLines).values({ storeId, fulfillmentId: f!.id, orderLineId: line.id, quantity: w.quantity });
      await tx.update(orderLines).set({ fulfilledQuantity: line.fulfilledQuantity + w.quantity }).where(eq(orderLines.id, line.id));
      line.fulfilledQuantity += w.quantity;
      if (order.inventoryState === "reserved" && line.inventoryItemId && line.locationId && locationId) {
        changes.push({ inventoryItemId: line.inventoryItemId, locationId: line.locationId, quantity: "committed", delta: -w.quantity });
        if (locationId !== line.locationId) {
          // Shipped from elsewhere: give the reserved units back where they were held.
          changes.push(
            { inventoryItemId: line.inventoryItemId, locationId: line.locationId, quantity: "available", delta: w.quantity },
            { inventoryItemId: line.inventoryItemId, locationId, quantity: "available", delta: -w.quantity },
          );
        }
      }
    }
    if (changes.length) await touchInventory(tx, storeId, await applyInventoryChanges(tx, actor, storeId, changes, "order", `Fulfilled ${f!.name}`));
    const status = await recomputeFulfillmentStatus(tx, order);
    const units = wanted.reduce((s, w) => s + w.quantity, 0);
    await addOrderEvent(tx, storeId, orderId, "fulfilled", `${units} item${units === 1 ? "" : "s"} fulfilled (${f!.name}) via ${carrierName(f!)}${tracking.trackingNumber ? ` ${tracking.trackingNumber}` : ""}`, staffActor(actor), {
      fulfillmentId: f!.id,
      status,
    });
    if (d.notifyCustomer && d.method !== "none") {
      await enqueueEvent(tx, {
        storeId,
        type: "order.shipping_updated",
        payload: { orderId, eventId: f!.id, carrier: carrierName(f!), trackingNumber: tracking.trackingNumber, trackingUrl: tracking.trackingUrl, message: d.method === "local_driver" ? deliveryLines(f!).slice(1).join("\n") : undefined },
      });
    }
    await writeAudit(tx, actor, { storeId, action: "order.fulfilled", resourceType: "order", resourceId: orderId, metadata: { fulfillmentId: f!.id } });
    return fulfillmentView(f!, wanted);
  });
}

async function linesWeight(db: Executor, lines: { variantId: string | null; quantity: number }[]) {
  const ids = lines.map((l) => l.variantId).filter((x): x is string => !!x);
  if (!ids.length) return 0;
  const rows = await db.select({ id: productVariants.id, weight: productVariants.weight, unit: productVariants.weightUnit }).from(productVariants).where(inArray(productVariants.id, ids));
  return lines.reduce((s, l) => {
    const r = rows.find((x) => x.id === l.variantId);
    return s + (r ? toGrams(r.weight, r.unit) * l.quantity : 0);
  }, 0);
}

export function fulfillmentView(f: FulfillmentRow, lines: { orderLineId: string; quantity: number }[]) {
  return {
    id: f.id,
    name: f.name,
    status: f.status,
    method: f.method,
    carrier: f.carrier,
    carrierName: carrierName(f),
    trackingNumber: f.trackingNumber,
    trackingUrl: f.trackingUrl,
    driverName: f.driverName,
    driverMobile: f.driverMobile,
    tripLink: f.tripLink,
    provider: f.provider,
    labelUrl: f.labelUrl,
    locationId: f.locationId,
    notifyCustomer: f.notifyCustomer,
    whatsappSentAt: f.whatsappSentAt?.toISOString() ?? null,
    deliveredAt: f.deliveredAt?.toISOString() ?? null,
    createdAt: f.createdAt.toISOString(),
    deliveryLines: deliveryLines(f),
    lines,
  };
}
export type FulfillmentView = ReturnType<typeof fulfillmentView>;

export async function listFulfillments(db: Executor, orderId: string) {
  const rows = await db.select().from(fulfillments).where(eq(fulfillments.orderId, orderId)).orderBy(asc(fulfillments.createdAt));
  const lines = rows.length ? await db.select().from(fulfillmentLines).where(inArray(fulfillmentLines.fulfillmentId, rows.map((r) => r.id))) : [];
  return rows.map((f) => fulfillmentView(f, lines.filter((l) => l.fulfillmentId === f.id).map((l) => ({ orderLineId: l.orderLineId, quantity: l.quantity }))));
}

async function lockFulfillment(tx: Executor, storeId: string, orderId: string, id: string) {
  const [f] = await tx.select().from(fulfillments).where(and(eq(fulfillments.storeId, storeId), eq(fulfillments.orderId, orderId), eq(fulfillments.id, id))).for("update");
  if (!f) throw notFound("Fulfillment");
  return f;
}

export const trackingUpdateInput = z.object({
  carrier: z.string().trim().max(60).nullish(),
  trackingNumber: z.string().trim().max(60).nullish(),
  trackingUrl: httpUrl.nullish().or(z.literal("")),
  status: z.enum(["pending", "shipped", "in_transit", "out_for_delivery", "delivered", "failed"]).optional(),
  notifyCustomer: z.boolean().default(false),
});

const STATUS_LABEL: Record<string, string> = {
  pending: "Ready for pickup",
  shipped: "Shipped",
  in_transit: "In transit",
  out_for_delivery: "Out for delivery",
  delivered: "Delivered",
  failed: "Delivery attempt failed",
  cancelled: "Cancelled",
};

/** Staff edits tracking or marks a status (e.g. delivered for local drivers). */
export async function updateFulfillmentTracking(deps: CoreDeps, actor: Actor, storeId: string, orderId: string, fulfillmentId: string, input: z.input<typeof trackingUpdateInput>) {
  const d = trackingUpdateInput.parse(input);
  return deps.db.transaction(async (tx) => {
    const f = await lockFulfillment(tx, storeId, orderId, fulfillmentId);
    if (f.status === "cancelled") throw new AppError("conflict", "This fulfillment was cancelled");
    const carrier = d.carrier !== undefined ? d.carrier || null : f.carrier;
    const trackingNumber = d.trackingNumber !== undefined ? d.trackingNumber || null : f.trackingNumber;
    const trackingUrl = d.trackingUrl !== undefined ? d.trackingUrl || (f.method === "courier" && trackingNumber ? courierTrackingUrl(carrier ?? "", trackingNumber) : null) : f.trackingUrl;
    const status = d.status ?? f.status;
    await tx
      .update(fulfillments)
      .set({ carrier, trackingNumber, trackingUrl, status, deliveredAt: status === "delivered" ? (f.deliveredAt ?? now(deps)) : null })
      .where(eq(fulfillments.id, f.id));
    await addOrderEvent(tx, storeId, orderId, "fulfillment_updated", `${f.name}: ${status !== f.status ? STATUS_LABEL[status] : "tracking updated"}`, staffActor(actor), { fulfillmentId: f.id, status });
    if (d.notifyCustomer) await enqueueEvent(tx, { storeId, type: "order.fulfillment_updated", payload: { orderId, fulfillmentId: f.id, status, statusLabel: STATUS_LABEL[status], trackingUrl } });
    await writeAudit(tx, actor, { storeId, action: "fulfillment.updated", resourceType: "order", resourceId: orderId, metadata: { fulfillmentId: f.id } });
  });
}

/** Cancels a fulfillment: its units go back to "to fulfil" and stock is reserved again. */
export async function cancelFulfillment(deps: CoreDeps, actor: Actor, storeId: string, orderId: string, fulfillmentId: string) {
  await deps.db.transaction(async (tx) => {
    const order = await lockOrder(tx, storeId, orderId);
    const f = await lockFulfillment(tx, storeId, orderId, fulfillmentId);
    if (f.status === "cancelled") return;
    if (f.status === "delivered") throw new AppError("conflict", "Delivered fulfillments cannot be cancelled; create a return instead");
    const fl = await tx.select().from(fulfillmentLines).where(eq(fulfillmentLines.fulfillmentId, f.id));
    const lines = await tx.select().from(orderLines).where(eq(orderLines.orderId, orderId)).for("update");
    const changes: QuantityChange[] = [];
    for (const x of fl) {
      const line = lines.find((l) => l.id === x.orderLineId)!;
      const qty = Math.min(x.quantity, line.fulfilledQuantity - line.returnedQuantity);
      if (qty <= 0) continue;
      await tx.update(orderLines).set({ fulfilledQuantity: line.fulfilledQuantity - qty, ...(f.locationId ? { locationId: f.locationId } : {}) }).where(eq(orderLines.id, line.id));
      if (order.inventoryState === "reserved" && line.inventoryItemId && f.locationId) {
        changes.push({ inventoryItemId: line.inventoryItemId, locationId: f.locationId, quantity: "committed", delta: qty });
      }
    }
    if (changes.length) await touchInventory(tx, storeId, await applyInventoryChanges(tx, actor, storeId, changes, "order", `Cancelled ${f.name}`));
    await tx.update(fulfillments).set({ status: "cancelled", cancelledAt: now(deps) }).where(eq(fulfillments.id, f.id));
    await recomputeFulfillmentStatus(tx, order);
    await addOrderEvent(tx, storeId, orderId, "fulfillment_cancelled", `${f.name} cancelled`, staffActor(actor), { fulfillmentId: f.id });
    await writeAudit(tx, actor, { storeId, action: "fulfillment.cancelled", resourceType: "order", resourceId: orderId, metadata: { fulfillmentId: f.id } });
  });
}

/**
 * "Send delivery details on WhatsApp" (PLS `deliveryMessageLink`): a wa.me link to the customer's
 * number with the delivery details filled in; staff tap Send. Records that it was used.
 */
export async function whatsappDeliveryLink(deps: CoreDeps, actor: Actor, storeId: string, orderId: string, fulfillmentId: string) {
  return deps.db.transaction(async (tx) => {
    const order = await lockOrder(tx, storeId, orderId);
    const f = await lockFulfillment(tx, storeId, orderId, fulfillmentId);
    const phone = normalizeMobile(order.shippingAddress?.phone ?? order.phone ?? "");
    if (phone.length < 8) throw new AppError("validation_failed", "The order has no customer mobile number");
    const store = await getStore(tx, storeId);
    const fl = await tx.select({ quantity: fulfillmentLines.quantity, title: orderLines.title }).from(fulfillmentLines).innerJoin(orderLines, eq(orderLines.id, fulfillmentLines.orderLineId)).where(eq(fulfillmentLines.fulfillmentId, f.id));
    const firstName = order.shippingAddress?.firstName?.trim().split(/\s+/)[0] || "there";
    const items = fl.map((l) => `${l.title} × ${l.quantity}`).join(", ");
    const text = [`Hi ${firstName}! 👋`, `Your order *${order.name}* (${items}) has been shipped 📦`, "", ...deliveryLines(f), "", `Thank you for shopping with ${store.name} 💛`].join("\n");
    const international = phone.length === 10 && (store.country ?? "IN") === "IN" ? `91${phone}` : phone;
    await tx.update(fulfillments).set({ whatsappSentAt: now(deps) }).where(eq(fulfillments.id, f.id));
    await addOrderEvent(tx, storeId, orderId, "whatsapp_sent", `Delivery details for ${f.name} sent on WhatsApp`, staffActor(actor), { fulfillmentId: f.id });
    return { url: `https://wa.me/${international}?text=${encodeURIComponent(text)}`, text };
  });
}

/** A carrier label URL (created at shipment time, or fetched now). */
export async function fulfillmentLabel(deps: CoreDeps, storeId: string, orderId: string, fulfillmentId: string) {
  const [f] = await deps.db.select().from(fulfillments).where(and(eq(fulfillments.storeId, storeId), eq(fulfillments.orderId, orderId), eq(fulfillments.id, fulfillmentId)));
  if (!f) throw notFound("Fulfillment");
  if (f.labelUrl || !f.provider || !f.providerShipmentId || !f.trackingNumber) return { url: f.labelUrl };
  const provider = await shippingProvider(deps, storeId, f.provider);
  const url = provider ? await provider.label({ shipmentId: f.providerShipmentId, awb: f.trackingNumber }) : null;
  if (url) await deps.db.update(fulfillments).set({ labelUrl: url }).where(eq(fulfillments.id, f.id));
  return { url };
}

/** The enabled credentials for a carrier (live preferred over test). */
export async function shippingProvider(deps: CoreDeps, storeId: string, providerId: string): Promise<ShippingProvider | null> {
  return (await loadProvider(deps, { storeId, kind: "shipping", provider: providerId, mode: "live" })) ?? (await loadProvider(deps, { storeId, kind: "shipping", provider: providerId, mode: "test" }));
}

const TRACKING_TO_STATUS: Record<TrackingState, FulfillmentRow["status"] | null> = {
  pending: null,
  in_transit: "in_transit",
  out_for_delivery: "out_for_delivery",
  delivered: "delivered",
  failed: "failed",
  returned: "failed",
  cancelled: "cancelled",
};

/**
 * Carrier tracking webhooks (`/api/webhooks/shipping/:provider`): signature/token checked by the
 * adapter on the raw body, deduped by event id, then the matching fulfillment's status moves.
 */
export async function handleShippingWebhook(deps: CoreDeps, storeId: string, providerId: string, rawBody: Buffer, headers: Record<string, string | string[] | undefined>) {
  const creds = await deps.db.select({ mode: providerCredentials.mode }).from(providerCredentials).where(and(eq(providerCredentials.storeId, storeId), eq(providerCredentials.kind, "shipping"), eq(providerCredentials.provider, providerId)));
  let events = null;
  for (const c of creds) {
    const p = await loadProvider(deps, { storeId, kind: "shipping", provider: providerId, mode: c.mode });
    if (!p) continue;
    try {
      events = await p.parseWebhook(rawBody, headers);
      break;
    } catch {
      /* try the other mode's secret */
    }
  }
  if (!events) throw new AppError("unauthorized", "Invalid webhook signature");
  let applied = 0;
  for (const e of events) {
    await deps.db.transaction(async (tx) => {
      const [claimed] = await tx.insert(shippingWebhookEvents).values({ storeId, provider: providerId, eventId: e.id, status: e.state }).onConflictDoNothing().returning({ id: shippingWebhookEvents.id });
      if (!claimed) return;
      const [f] = await tx.select().from(fulfillments).where(and(eq(fulfillments.storeId, storeId), eq(fulfillments.trackingNumber, e.awb))).for("update");
      if (!f) return;
      await tx.update(shippingWebhookEvents).set({ fulfillmentId: f.id }).where(eq(shippingWebhookEvents.id, claimed.id));
      const status = TRACKING_TO_STATUS[e.state];
      if (!status || status === f.status || f.status === "cancelled" || f.status === "delivered") return;
      await tx.update(fulfillments).set({ status, deliveredAt: status === "delivered" ? new Date(Date.parse(e.at) || Date.now()) : null }).where(eq(fulfillments.id, f.id));
      await addOrderEvent(tx, storeId, f.orderId, "fulfillment_updated", `${f.name}: ${STATUS_LABEL[status]}${e.description ? ` (${e.description})` : ""}`, { type: "provider" }, { fulfillmentId: f.id, status });
      if (f.notifyCustomer && (status === "out_for_delivery" || status === "delivered" || status === "failed")) {
        await enqueueEvent(tx, { storeId, type: "order.fulfillment_updated", payload: { orderId: f.orderId, fulfillmentId: f.id, status, statusLabel: STATUS_LABEL[status], description: e.description, trackingUrl: f.trackingUrl } });
      }
      applied++;
    });
  }
  return { received: events.length, applied };
}
