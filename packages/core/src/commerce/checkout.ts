import { sha256Hex } from "@shopkit/crypto";
import {
  and,
  cartLines,
  carts,
  checkouts,
  customerAddresses,
  customers,
  desc,
  eq,
  orders,
  paymentSessions,
  paymentWebhookEvents,
  providerCredentials,
  sql,
  transactions,
  UUID_RE,
  type Executor,
} from "@shopkit/db";
import { ProviderError, WebhookSignatureError, type PaymentProvider, type PaymentWebhookEvent, type ProviderMode } from "@shopkit/providers";
import { z } from "zod";
import { loadProvider } from "../credentials.js";
import type { CoreDeps } from "../deps.js";
import { now } from "../deps.js";
import { AppError, notFound } from "../errors.js";
import { enqueueEvent } from "../outbox.js";
import { getSetting } from "../settings.js";
import { getInstallStore } from "../stores.js";
import { fullName, mailingAddressSchema } from "./address.js";
import { linesWithImages } from "./carts.js";
import {
  addOrderEvent,
  applyPaymentResult,
  applyProviderRefund,
  lockOrder,
  orderStatusToken,
  placeOrder,
  releaseInventory,
  reserveInventory,
  totalsFromPricing,
  writeOrderLines,
  type OrderRow,
} from "./orders.js";
import { priceLines, type Pricing } from "./pricing.js";

type CheckoutRow = typeof checkouts.$inferSelect;
type CartRow = typeof carts.$inferSelect;

// ── Access ───────────────────────────────────────────────────────────────────
/** Opens (or reopens) the checkout for the cookie's cart. Signed-in customers get their details prefilled. */
export async function startCheckout(deps: CoreDeps, storeId: string, cart: CartRow, customerId?: string | null): Promise<CheckoutRow> {
  const [count] = await deps.db.select({ n: sql<number>`count(*)::int` }).from(cartLines).where(eq(cartLines.cartId, cart.id));
  if (!count?.n) throw new AppError("validation_failed", "Your cart is empty");
  const [existing] = await deps.db.select().from(checkouts).where(eq(checkouts.cartId, cart.id));
  if (existing) {
    if (customerId && !existing.customerId) await deps.db.update(checkouts).set({ customerId }).where(eq(checkouts.id, existing.id));
    return existing;
  }
  let prefill: Partial<typeof checkouts.$inferInsert> = {};
  if (customerId) {
    const [c] = await deps.db.select().from(customers).where(and(eq(customers.storeId, storeId), eq(customers.id, customerId)));
    const [addr] = await deps.db.select().from(customerAddresses).where(eq(customerAddresses.customerId, customerId)).orderBy(desc(customerAddresses.isDefault)).limit(1);
    if (c) prefill = { customerId, email: c.email, phone: c.phone, marketingConsent: c.marketingConsent };
    if (addr) {
      const { firstName, lastName, company, line1, line2, city, province, postalCode, country, phone } = addr;
      prefill.shippingAddress = { firstName, lastName, company, line1, line2, city, province, postalCode, country, phone };
    }
  }
  const [row] = await deps.db.insert(checkouts).values({ storeId, cartId: cart.id, ...prefill }).onConflictDoNothing().returning();
  if (row) return row;
  const [again] = await deps.db.select().from(checkouts).where(eq(checkouts.cartId, cart.id));
  return again!;
}

/** A checkout is reachable only with its cart's cookie token (completed carts included, for the return page). */
export async function loadCheckout(db: Executor, storeId: string, checkoutId: string, cartToken: string | undefined): Promise<{ checkout: CheckoutRow; cart: CartRow }> {
  if (!UUID_RE.test(checkoutId) || !cartToken || cartToken.length > 100) throw notFound("Checkout");
  const [row] = await db
    .select({ checkout: checkouts, cart: carts })
    .from(checkouts)
    .innerJoin(carts, eq(carts.id, checkouts.cartId))
    .where(and(eq(checkouts.storeId, storeId), eq(checkouts.id, checkoutId), eq(carts.tokenHash, sha256Hex(cartToken))));
  if (!row) throw notFound("Checkout");
  return row;
}

// ── Updates ──────────────────────────────────────────────────────────────────
export const checkoutUpdateInput = z.object({
  email: z.email().max(254).nullish(),
  phone: z.string().trim().max(40).nullish(),
  marketingConsent: z.boolean().optional(),
  shippingAddress: mailingAddressSchema.nullish(),
  billingAddress: mailingAddressSchema.nullish(),
  shippingRateId: z.string().max(100).nullish(),
  paymentProvider: z.string().max(60).nullish(),
  discountCode: z.string().trim().max(40).nullish(),
  note: z.string().max(2000).nullish(),
});
export type CheckoutUpdate = z.input<typeof checkoutUpdateInput>;

export async function updateCheckout(deps: CoreDeps, storeId: string, checkout: CheckoutRow, cart: CartRow, input: CheckoutUpdate) {
  if (checkout.status === "completed") throw new AppError("conflict", "This checkout is already complete");
  const d = checkoutUpdateInput.parse(input);
  const set: Partial<typeof checkouts.$inferInsert> = { updatedAt: now(deps) };
  if (d.email !== undefined) set.email = d.email?.toLowerCase() ?? null;
  if (d.phone !== undefined) set.phone = d.phone || null;
  if (d.marketingConsent !== undefined) set.marketingConsent = d.marketingConsent;
  if (d.shippingAddress !== undefined) set.shippingAddress = d.shippingAddress ?? null;
  if (d.billingAddress !== undefined) set.billingAddress = d.billingAddress ?? null;
  if (d.shippingRateId !== undefined) set.shippingRateId = d.shippingRateId ?? null;
  if (d.paymentProvider !== undefined) {
    if (d.paymentProvider && !(await paymentMethods(deps, storeId)).some((m) => m.id === d.paymentProvider)) throw new AppError("validation_failed", "That payment method is not available");
    set.paymentProvider = d.paymentProvider ?? null;
  }
  // Editing the email restarts the abandoned-checkout clock and allows a new reminder.
  if (d.email !== undefined && d.email?.toLowerCase() !== checkout.email) set.abandonedNotifiedAt = null;
  await deps.db.update(checkouts).set(set).where(eq(checkouts.id, checkout.id));
  if (d.discountCode !== undefined || d.note !== undefined) {
    await deps.db
      .update(carts)
      .set({
        ...(d.discountCode !== undefined ? { discountCode: d.discountCode?.trim() || null } : {}),
        ...(d.note !== undefined ? { note: d.note?.trim() || null } : {}),
        updatedAt: now(deps),
      })
      .where(eq(carts.id, cart.id));
  }
}

// ── Payment methods ──────────────────────────────────────────────────────────
export interface PaymentMethod {
  id: string;
  displayName: string;
  flow: "widget" | "redirect" | "offline";
  mode: ProviderMode;
}

/**
 * Methods the shopper can pick: enabled credentials in the store's payments mode, plus offline
 * methods (COD, bank transfer), which only have a live mode.
 */
export async function paymentMethods(deps: CoreDeps, storeId: string): Promise<PaymentMethod[]> {
  const mode = await getSetting(deps.db, storeId, "payments.mode");
  const rows = await deps.db
    .select({ provider: providerCredentials.provider, mode: providerCredentials.mode })
    .from(providerCredentials)
    .where(and(eq(providerCredentials.storeId, storeId), eq(providerCredentials.kind, "payment"), eq(providerCredentials.enabled, true)));
  const out: PaymentMethod[] = [];
  for (const r of rows) {
    const def = deps.registry.get("payment", r.provider);
    if (!def) continue;
    const flow = def.paymentFlow ?? "widget";
    if (flow === "offline" ? true : r.mode === mode) {
      if (out.some((m) => m.id === def.id)) continue;
      out.push({ id: def.id, displayName: def.displayName, flow, mode: r.mode });
    }
  }
  const order = ["razorpay", "stripe", "paypal", "cashfree", "phonepe", "bank-transfer", "cod"];
  const rank = (id: string) => (order.includes(id) ? order.indexOf(id) : order.length);
  return out.sort((a, b) => rank(a.id) - rank(b.id));
}

// ── View ─────────────────────────────────────────────────────────────────────
async function priceCheckout(deps: CoreDeps, storeId: string, checkout: CheckoutRow, cart: CartRow, executor: Executor = deps.db): Promise<Pricing> {
  const rows = await executor.select().from(cartLines).where(eq(cartLines.cartId, cart.id)).orderBy(cartLines.createdAt, cartLines.id);
  return priceLines(executor, storeId, {
    lines: rows.map((r) => ({ variantId: r.variantId, quantity: r.quantity, attributes: r.attributes, ref: r.id })),
    shippingAddress: checkout.shippingAddress,
    shippingRateId: checkout.shippingRateId,
    discountCode: cart.discountCode,
    customer: { id: checkout.customerId, email: checkout.email },
    orderId: checkout.orderId,
    at: now(deps),
  });
}

/** Everything the one-page checkout renders, priced server-side. */
export async function checkoutView(deps: CoreDeps, storeId: string, checkout: CheckoutRow, cart: CartRow) {
  const [pricing, methods, cfg] = await Promise.all([priceCheckout(deps, storeId, checkout, cart), paymentMethods(deps, storeId), getSetting(deps.db, storeId, "checkout.config")]);
  const missing: string[] = [];
  if (!checkout.email) missing.push("email");
  if (cfg.requirePhone && !checkout.phone) missing.push("phone");
  if (pricing.shippingRequired && !checkout.shippingAddress) missing.push("shipping_address");
  if (pricing.shippingRequired && checkout.shippingAddress && !pricing.shippingLine) missing.push("shipping_rate");
  if (!checkout.paymentProvider || !methods.some((m) => m.id === checkout.paymentProvider)) missing.push("payment_method");
  const completedOrder = checkout.status === "completed" && checkout.orderId ? orderStatusToken(deps, checkout.orderId) : null;
  return {
    id: checkout.id,
    status: checkout.status,
    email: checkout.email,
    phone: checkout.phone,
    marketingConsent: checkout.marketingConsent,
    shippingAddress: checkout.shippingAddress,
    billingAddress: checkout.billingAddress,
    shippingRateId: pricing.shippingLine?.id ?? checkout.shippingRateId,
    paymentProvider: checkout.paymentProvider,
    note: cart.note,
    currency: pricing.currency,
    lines: await linesWithImages(deps, pricing),
    unavailable: pricing.unavailable.map((u) => ({ lineId: u.ref, variantId: u.variantId, reason: u.reason })),
    itemCount: pricing.itemCount,
    subtotal: pricing.subtotal,
    discountTotal: pricing.discountTotal,
    shippingTotal: pricing.shippingTotal,
    taxTotal: pricing.taxTotal,
    total: pricing.total,
    taxesIncluded: pricing.taxesIncluded,
    taxLines: pricing.taxLines,
    discount: { code: pricing.discount.code, applied: pricing.discount.applied, error: pricing.discount.error, amount: pricing.discount.application?.amount ?? 0 },
    shippingRequired: pricing.shippingRequired,
    shippingRates: pricing.shippingRates,
    shippingLine: pricing.shippingLine,
    paymentMethods: methods.map((m) => ({ id: m.id, displayName: m.displayName, flow: m.flow })),
    requirePhone: cfg.requirePhone,
    missing,
    blockers: pricing.blockers,
    orderStatusToken: completedOrder,
  };
}
export type CheckoutView = Awaited<ReturnType<typeof checkoutView>>;

// ── Payment session (SPEC §7 "Payment flow" step 1) ──────────────────────────
export interface PaymentSessionResult {
  orderId: string;
  flow: "widget" | "redirect" | "offline";
  provider: string;
  clientPayload: Record<string, unknown>;
  redirectUrl: string | null;
  /** Set once the order is placed (offline methods), for the thank-you page. */
  orderStatusToken: string | null;
}

/**
 * Recomputes the totals from the database, creates or refreshes the checkout's order (unplaced,
 * pending payment), reserves its stock with a delayed release, then asks the provider for a session
 * for exactly that server-side total. Offline methods place the order immediately.
 */
export async function createPaymentSession(deps: CoreDeps, storeId: string, checkoutId: string, cartToken: string | undefined): Promise<PaymentSessionResult> {
  const cfg = await getSetting(deps.db, storeId, "checkout.config");
  const methods = await paymentMethods(deps, storeId);
  const prepared = await deps.db.transaction(async (tx) => {
    const { checkout, cart } = await loadCheckout(tx, storeId, checkoutId, cartToken);
    await tx.select({ id: checkouts.id }).from(checkouts).where(eq(checkouts.id, checkout.id)).for("update");
    if (checkout.status === "completed") throw new AppError("conflict", "This checkout is already complete");
    const method = methods.find((m) => m.id === checkout.paymentProvider);
    if (!method) throw new AppError("validation_failed", "Choose a payment method");
    if (!checkout.email) throw new AppError("validation_failed", "Enter your email");
    if (cfg.requirePhone && !checkout.phone) throw new AppError("validation_failed", "Enter your phone number");
    const pricing = await priceCheckout(deps, storeId, checkout, cart, tx);
    if (pricing.blockers.length) throw new AppError("conflict", pricing.blockers[0]!, { blockers: pricing.blockers });
    if (pricing.shippingRequired && (!checkout.shippingAddress || !pricing.shippingLine)) throw new AppError("validation_failed", "Choose a shipping address and method");
    if (pricing.total <= 0) throw new AppError("validation_failed", "Free orders are not supported yet");

    const at = now(deps);
    const fields = {
      ...totalsFromPricing(pricing),
      email: checkout.email,
      phone: checkout.phone,
      customerId: checkout.customerId ?? cart.customerId,
      shippingAddress: checkout.shippingAddress,
      billingAddress: checkout.billingAddress ?? checkout.shippingAddress,
      note: cart.note,
      attributes: cart.attributes,
      marketingConsent: checkout.marketingConsent,
      paymentProvider: method.id,
      paymentMode: method.mode,
      reservationExpiresAt: new Date(at.getTime() + cfg.reservationMinutes * 60_000),
    };
    let order: OrderRow | undefined;
    if (checkout.orderId) {
      const [existing] = await tx.select().from(orders).where(eq(orders.id, checkout.orderId)).for("update");
      if (existing && !existing.placedAt && existing.status !== "cancelled") order = existing;
    }
    if (order) {
      // Cart or choices may have changed since the last attempt: re-reserve the new quantities.
      await releaseInventory(tx, storeId, order, { restock: true, note: `Checkout ${checkout.id} re-priced` });
      const [row] = await tx.update(orders).set(fields).where(eq(orders.id, order.id)).returning();
      order = row!;
    } else {
      const [row] = await tx.insert(orders).values({ storeId, checkoutId: checkout.id, sourceName: "web", ...fields }).returning();
      order = row!;
      await tx.update(checkouts).set({ orderId: order.id }).where(eq(checkouts.id, checkout.id));
      await addOrderEvent(tx, storeId, order.id, "checkout_started", "Customer started payment", { type: "customer", id: order.customerId });
    }
    await writeOrderLines(tx, storeId, order.id, pricing);
    await reserveInventory(tx, storeId, order);
    await tx.update(checkouts).set({ totals: { subtotal: pricing.subtotal, discountTotal: pricing.discountTotal, shippingTotal: pricing.shippingTotal, taxTotal: pricing.taxTotal, total: pricing.total, taxesIncluded: pricing.taxesIncluded } }).where(eq(checkouts.id, checkout.id));
    if (method.flow === "offline") {
      await placeOrder(tx, deps, order, { paid: false, actor: { type: "customer", id: order.customerId } });
      await tx.insert(paymentSessions).values({ storeId, orderId: order.id, provider: method.id, mode: method.mode, providerOrderId: null, amount: order.total, currency: order.currency });
    } else {
      await enqueueEvent(tx, { storeId, type: "order.reservation_created", payload: { orderId: order.id, dueAt: fields.reservationExpiresAt.toISOString() } });
    }
    return { order, method, customerName: fullName(checkout.shippingAddress) };
  });

  const { order, method } = prepared;
  const provider = await loadProvider(deps, { storeId, kind: "payment", provider: method.id, mode: method.mode });
  if (!provider) throw new AppError("conflict", "That payment method is not available");
  const returnUrl = `${deps.runtime.publicUrl}/checkout/return?checkout=${checkoutId}&provider=${encodeURIComponent(method.id)}`;
  let session;
  try {
    session = await provider.createSession({
      order: { id: order.id, ...(order.name ? { number: order.name } : {}) },
      amount: order.total,
      currency: order.currency,
      customer: { ...(prepared.customerName ? { name: prepared.customerName } : {}), ...(order.email ? { email: order.email } : {}), ...(order.phone ? { phone: order.phone } : {}) },
      returnUrl,
    });
  } catch (err) {
    throw new AppError("provider_error", err instanceof ProviderError ? err.message : "The payment provider could not be reached. Try again.");
  }
  if (method.flow !== "offline") {
    await deps.db.insert(paymentSessions).values({ storeId, orderId: order.id, provider: method.id, mode: method.mode, providerOrderId: session.providerOrderId, amount: order.total, currency: order.currency });
  }
  return {
    orderId: order.id,
    flow: method.flow,
    provider: method.id,
    clientPayload: session.clientPayload,
    redirectUrl: session.redirectUrl ?? null,
    orderStatusToken: method.flow === "offline" ? orderStatusToken(deps, order.id) : null,
  };
}

// ── Client return (fast path, step 3) ────────────────────────────────────────
export const verifyInput = z.object({ payload: z.record(z.string(), z.unknown()) });

/**
 * Verifies the provider's return for the checkout's order. The result must belong to one of this
 * order's sessions (or name the order), so a valid payment for another order cannot be replayed.
 */
export async function verifyCheckoutPayment(deps: CoreDeps, storeId: string, checkoutId: string, cartToken: string | undefined, payload: Record<string, unknown>) {
  const { checkout } = await loadCheckout(deps.db, storeId, checkoutId, cartToken);
  if (!checkout.orderId) throw new AppError("conflict", "No payment was started for this checkout");
  const [order] = await deps.db.select().from(orders).where(eq(orders.id, checkout.orderId));
  if (!order?.paymentProvider || !order.paymentMode) throw new AppError("conflict", "No payment was started for this checkout");
  const sessions = await deps.db.select().from(paymentSessions).where(and(eq(paymentSessions.orderId, order.id), eq(paymentSessions.provider, order.paymentProvider))).orderBy(desc(paymentSessions.createdAt));
  const provider = await loadProvider(deps, { storeId, kind: "payment", provider: order.paymentProvider, mode: order.paymentMode });
  if (!provider) throw new AppError("conflict", "That payment method is not available");
  // PhonePe returns without parameters: look up the latest session server-side.
  const input = order.paymentProvider === "phonepe" ? { merchantOrderId: sessions[0]?.providerOrderId } : payload;
  let result;
  try {
    result = await provider.verifyReturn(input);
  } catch (err) {
    if (err instanceof WebhookSignatureError) throw new AppError("bad_request", "We could not verify that payment");
    throw new AppError("provider_error", err instanceof Error ? err.message : "Payment verification failed");
  }
  const ours = sessions.some((s) => s.providerOrderId && s.providerOrderId === result.providerOrderId) || result.orderReference === order.id;
  if (!ours) throw new AppError("bad_request", "That payment does not belong to this checkout");
  await deps.db.transaction(async (tx) => {
    const locked = await lockOrder(tx, storeId, order.id);
    await applyPaymentResult(tx, deps, locked, result, { provider: order.paymentProvider!, mode: order.paymentMode, via: "return" });
  });
  const [after] = await deps.db.select().from(orders).where(eq(orders.id, order.id));
  return {
    status: after!.placedAt ? ("paid" as const) : result.status === "failed" ? ("failed" as const) : ("pending" as const),
    message: result.status === "failed" ? (result.errorDescription ?? "The payment failed. Try again or choose another method.") : null,
    orderStatusToken: after!.placedAt ? orderStatusToken(deps, order.id) : null,
  };
}

// ── Webhooks (source of truth, step 4) ───────────────────────────────────────
export type WebhookOutcome = "applied" | "duplicate" | "ignored" | "no_order";

async function findOrderForEvent(tx: Executor, storeId: string, provider: string, event: PaymentWebhookEvent): Promise<OrderRow | null> {
  const p = event.payment;
  const ref = p?.orderReference;
  if (ref && UUID_RE.test(ref)) {
    const [o] = await tx.select().from(orders).where(and(eq(orders.storeId, storeId), eq(orders.id, ref))).for("update");
    if (o) return o;
  }
  if (p?.providerOrderId) {
    const [s] = await tx
      .select({ orderId: paymentSessions.orderId })
      .from(paymentSessions)
      .where(and(eq(paymentSessions.storeId, storeId), eq(paymentSessions.provider, provider), eq(paymentSessions.providerOrderId, p.providerOrderId)))
      .limit(1);
    if (s) return lockOrder(tx, storeId, s.orderId);
  }
  if (p?.providerPaymentId) {
    const [t] = await tx
      .select({ orderId: transactions.orderId })
      .from(transactions)
      .where(and(eq(transactions.storeId, storeId), eq(transactions.provider, provider), eq(transactions.providerReference, p.providerPaymentId)))
      .limit(1);
    if (t) return lockOrder(tx, storeId, t.orderId);
  }
  return null;
}

/**
 * POST /webhooks/payments/:provider. Tries each saved credential of the provider (test and live)
 * until one verifies the signature on the raw body; then, in one transaction, records the event id
 * (unique) and applies it. A replay hits the unique key and changes nothing.
 */
export async function handlePaymentWebhook(
  deps: CoreDeps,
  providerId: string,
  rawBody: Buffer,
  headers: Record<string, string | string[] | undefined>,
): Promise<{ outcome: WebhookOutcome; eventId: string }> {
  const store = await getInstallStore(deps.db);
  if (!store) throw new AppError("not_found", "Unknown shop");
  const storeId = store.id;
  if (!deps.registry.get("payment", providerId)) throw new AppError("not_found", "Unknown payment provider");
  const creds = await deps.db
    .select({ mode: providerCredentials.mode })
    .from(providerCredentials)
    .where(and(eq(providerCredentials.storeId, storeId), eq(providerCredentials.kind, "payment"), eq(providerCredentials.provider, providerId)));
  let event: PaymentWebhookEvent | null = null;
  let mode: ProviderMode | null = null;
  for (const c of [...creds].sort((a, b) => (a.mode === b.mode ? 0 : a.mode === "live" ? -1 : 1))) {
    const provider: PaymentProvider | null = await loadProvider(deps, { storeId, kind: "payment", provider: providerId, mode: c.mode });
    if (!provider) continue;
    try {
      event = await provider.parseWebhook(rawBody, headers);
      mode = c.mode;
      break;
    } catch (err) {
      if (!(err instanceof WebhookSignatureError)) throw new AppError("provider_error", err instanceof Error ? err.message : "Webhook verification failed");
    }
  }
  if (!event) throw new AppError("unauthorized", "Invalid webhook signature");
  const verified = event;

  const outcome = await deps.db.transaction(async (tx): Promise<WebhookOutcome> => {
    const [claimed] = await tx
      .insert(paymentWebhookEvents)
      .values({ storeId, provider: providerId, eventId: verified.id, type: verified.providerType })
      .onConflictDoNothing()
      .returning({ id: paymentWebhookEvents.id });
    if (!claimed) return "duplicate";
    const order = await findOrderForEvent(tx, storeId, providerId, verified);
    let result: WebhookOutcome = "ignored";
    if (!order) result = "no_order";
    else if (verified.type === "payment.captured" || verified.type === "payment.authorized" || verified.type === "payment.failed") {
      if (verified.payment) result = (await applyPaymentResult(tx, deps, order, verified.payment, { provider: providerId, mode, via: "webhook", eventId: verified.id })).changed ? "applied" : "ignored";
    } else if (verified.type === "refund.processed" && verified.refund) {
      result = (await applyProviderRefund(tx, deps, order, { id: verified.refund.id, amount: verified.refund.amount, currency: verified.payment?.currency ?? order.currency }, providerId, mode)).changed ? "applied" : "ignored";
    }
    await tx.update(paymentWebhookEvents).set({ orderId: order?.id ?? null, outcome: result }).where(eq(paymentWebhookEvents.id, claimed.id));
    return result;
  });
  deps.logger.info({ provider: providerId, eventId: verified.id, type: verified.providerType, outcome }, "payment webhook");
  return { outcome, eventId: verified.id };
}

