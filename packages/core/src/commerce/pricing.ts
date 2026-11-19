import {
  and,
  eq,
  inArray,
  inventoryItems,
  inventoryLevels,
  locations,
  productVariants,
  products,
  sql,
  type DiscountApplication,
  type Executor,
  type MailingAddress,
  type ShippingLine,
  type TaxLine,
} from "@shopkit/db";
import type { CoreDeps } from "../deps.js";
import { getSetting } from "../settings.js";
import { getStore } from "../stores.js";
import { allocate, applyDiscounts, roundHalf, type EngineLine } from "./discount-engine.js";
import { loadDiscountCandidates } from "./discounts.js";
import { applyGiftCardBalances, resolveGiftCards, type AppliedGiftCard } from "./gift-cards.js";
import { quoteShipping, toGrams, type ShippingOption } from "./shipping.js";
import { loadTaxContext, mergeTaxLines, rateForLine, splitTax, taxOn } from "./tax.js";


/**
 * The single pricing function (SPEC §1.6): cart, checkout, order creation and draft orders all
 * call `priceLines`. Every amount comes from the database; the browser only sends variant ids,
 * quantities and choices. Phase 4: the discount engine (codes + automatic, combinations), shipping
 * zones and rates, per-region tax rates with collection overrides, and gift cards.
 *
 * Order of operations: line subtotals → discounts (product, then order, then shipping class) →
 * shipping → tax per line on the discounted price (rounded half away from zero) → total →
 * gift cards (a payment method, applied after tax).
 */
export interface PriceLineInput {
  variantId: string;
  quantity: number;
  attributes?: Record<string, string>;
  /** Echoed back so callers can match cart/draft lines. */
  ref?: string;
}

export interface PricingInput {
  lines: PriceLineInput[];
  shippingAddress?: MailingAddress | null;
  shippingRateId?: string | null;
  /** One entered code (carts) … */
  discountCode?: string | null;
  /** … or several (API / drafts). */
  discountCodes?: string[];
  /** Draft orders: a staff-entered order discount instead of codes and automatic discounts. */
  manualDiscount?: { kind: "percentage" | "fixed_amount"; value: number; reason?: string | null } | null;
  /** Draft orders: a staff-entered shipping charge (null = none) instead of the store rates. */
  customShipping?: { title: string; amount: number } | null;
  giftCardCodes?: string[];
  customer?: { id?: string | null; email?: string | null };
  /** The order being re-priced, so its own discount use does not count against limits. */
  orderId?: string | null;
  at?: Date;
}

export interface PricedLine {
  ref: string | null;
  variantId: string;
  productId: string;
  productHandle: string;
  title: string;
  variantTitle: string | null;
  sku: string | null;
  hsnCode: string | null;
  imageMediaId: string | null;
  quantity: number;
  unitPrice: number;
  compareAtPrice: number | null;
  subtotal: number;
  discountAmount: number;
  taxAmount: number;
  taxLines: TaxLine[];
  /** Effective tax rate for the line (basis points). */
  taxRateBps: number;
  requiresShipping: boolean;
  taxable: boolean;
  giftCard: boolean;
  weightGrams: number;
  collectionIds: string[];
  attributes: Record<string, string>;
  inventoryItemId: string | null;
  tracked: boolean;
  inventoryPolicy: "deny" | "continue";
  /** Sum of `available` across active locations (tracked items only). */
  availableQuantity: number | null;
  /** Customer-facing stock problem, if any. */
  stockIssue: string | null;
}

export type ShippingRateOption = ShippingOption;

export interface Pricing {
  currency: string;
  lines: PricedLine[];
  /** Lines dropped because the product is gone or no longer for sale. */
  unavailable: { ref: string | null; variantId: string; reason: string }[];
  itemCount: number;
  subtotal: number;
  discountTotal: number;
  shippingTotal: number;
  taxTotal: number;
  total: number;
  taxesIncluded: boolean;
  taxLines: TaxLine[];
  /** The entered code's status (kept for the Phase 3 cart/checkout UI). */
  discount: { code: string | null; applied: boolean; error: string | null; application: DiscountApplication | null };
  /** Every discount applied, automatic ones included, with the code ids for usage records. */
  discounts: (DiscountApplication & { codeId: string | null })[];
  giftCards: AppliedGiftCard[];
  giftCardErrors: string[];
  giftCardTotal: number;
  /** What the customer still pays with a payment method: total − gift cards. */
  totalDue: number;
  weightGrams: number;
  shippingRequired: boolean;
  shippingRates: ShippingRateOption[];
  shippingLine: ShippingLine | null;
  /** Problems that must be fixed before payment. */
  blockers: string[];
}

export const MAX_LINE_QUANTITY = 999;

/** Loads the variants, their stock and collections in one round trip. */
async function loadVariants(db: Executor, storeId: string, variantIds: string[]) {
  const rows =
    variantIds.length === 0
      ? []
      : await db
          .select({
            variantId: productVariants.id,
            productId: products.id,
            handle: products.handle,
            productTitle: products.title,
            status: products.status,
            giftCard: products.giftCard,
            featuredMediaId: products.featuredMediaId,
            variantTitle: productVariants.title,
            price: productVariants.price,
            compareAtPrice: productVariants.compareAtPrice,
            sku: productVariants.sku,
            hsnCode: productVariants.hsnCode,
            weight: productVariants.weight,
            weightUnit: productVariants.weightUnit,
            requiresShipping: productVariants.requiresShipping,
            taxable: productVariants.taxable,
            inventoryPolicy: productVariants.inventoryPolicy,
            imageMediaId: productVariants.imageMediaId,
            inventoryItemId: inventoryItems.id,
            tracked: inventoryItems.tracked,
            available: sql<number | null>`(select sum(${inventoryLevels.available})::int from ${inventoryLevels}
        join ${locations} on ${locations.id} = ${inventoryLevels.locationId} and ${locations.active}
        where ${inventoryLevels.inventoryItemId} = ${inventoryItems.id})`,
            collectionIds: sql<string[]>`coalesce((select array_agg(cp.collection_id) from collection_products cp where cp.product_id = ${products.id}), '{}'::uuid[])`,
          })
          .from(productVariants)
          .innerJoin(products, eq(products.id, productVariants.productId))
          .leftJoin(inventoryItems, eq(inventoryItems.variantId, productVariants.id))
          .where(and(eq(productVariants.storeId, storeId), inArray(productVariants.id, variantIds)));
  return new Map(rows.map((r) => [r.variantId, r]));
}

export async function priceLines(db: Executor, storeId: string, input: PricingInput, opts: { deps?: CoreDeps } = {}): Promise<Pricing> {
  const at = input.at ?? new Date();
  const store = await getStore(db, storeId);
  const currency = store.currency ?? "USD";
  const tax = await getSetting(db, storeId, "tax.config");
  const variants = await loadVariants(db, storeId, [...new Set(input.lines.map((l) => l.variantId))]);

  const lines: PricedLine[] = [];
  const unavailable: Pricing["unavailable"] = [];
  const blockers: string[] = [];
  for (const l of input.lines) {
    const v = variants.get(l.variantId);
    if (!v || v.status !== "active") {
      unavailable.push({ ref: l.ref ?? null, variantId: l.variantId, reason: "This product is no longer available" });
      continue;
    }
    const quantity = Math.min(Math.max(1, Math.trunc(l.quantity)), MAX_LINE_QUANTITY);
    const tracked = !!v.inventoryItemId && v.tracked === true;
    const availableQuantity = tracked ? (v.available ?? 0) : null;
    let stockIssue: string | null = null;
    if (tracked && v.inventoryPolicy === "deny" && availableQuantity! < quantity) {
      stockIssue = availableQuantity! <= 0 ? "Sold out" : `Only ${availableQuantity} left`;
      blockers.push(`${v.productTitle}${v.variantTitle && v.variantTitle !== "Default Title" ? ` (${v.variantTitle})` : ""}: ${stockIssue.toLowerCase()}`);
    }
    lines.push({
      ref: l.ref ?? null,
      variantId: v.variantId,
      productId: v.productId,
      productHandle: v.handle,
      title: v.productTitle,
      variantTitle: v.variantTitle === "Default Title" ? null : v.variantTitle,
      sku: v.sku,
      hsnCode: v.hsnCode,
      imageMediaId: v.imageMediaId ?? v.featuredMediaId,
      quantity,
      unitPrice: v.price,
      compareAtPrice: v.compareAtPrice,
      subtotal: v.price * quantity,
      discountAmount: 0,
      taxAmount: 0,
      taxLines: [],
      taxRateBps: 0,
      // Gift cards are not shipped and not taxed when sold (tax applies when they are spent).
      requiresShipping: v.giftCard ? false : v.requiresShipping,
      taxable: v.giftCard ? false : v.taxable,
      giftCard: v.giftCard,
      weightGrams: toGrams(v.weight, v.weightUnit) * quantity,
      collectionIds: v.collectionIds ?? [],
      attributes: l.attributes ?? {},
      inventoryItemId: v.inventoryItemId,
      tracked,
      inventoryPolicy: v.inventoryPolicy,
      availableQuantity,
      stockIssue,
    });
  }

  const subtotal = lines.reduce((s, l) => s + l.subtotal, 0);
  const itemCount = lines.reduce((s, l) => s + l.quantity, 0);
  const shippingRequired = lines.some((l) => l.requiresShipping);
  const weightGrams = lines.filter((l) => l.requiresShipping).reduce((s, l) => s + l.weightGrams, 0);
  const engineLines: EngineLine[] = lines.map((l) => ({ productId: l.productId, collectionIds: l.collectionIds, unitPrice: l.unitPrice, quantity: l.quantity, giftCard: l.giftCard }));

  // ── Shipping options (priced on the subtotal before order discounts; recomputed below) ──
  let shippingRates: ShippingRateOption[] = [];
  let shippingLine: ShippingLine | null = null;
  const pickShipping = async (discountedShippableSubtotal: number) => {
    shippingRates = [];
    shippingLine = null;
    if (input.customShipping !== undefined) {
      if (input.customShipping) {
        const amount = Math.max(0, Math.trunc(input.customShipping.amount));
        shippingLine = { id: "custom", title: input.customShipping.title || "Shipping", amount, discount: 0, kind: "custom" };
        shippingRates = [{ id: "custom", title: shippingLine.title, amount, kind: "flat" }];
      }
      return;
    }
    if (!shippingRequired) return;
    const quote = await quoteShipping(db, storeId, { address: input.shippingAddress, subtotal: discountedShippableSubtotal, weightGrams, currency, ...(opts.deps ? { deps: opts.deps } : {}) });
    shippingRates = quote.options;
    const country = input.shippingAddress?.country?.toUpperCase();
    if (input.shippingAddress && (!quote.ships || shippingRates.length === 0)) blockers.push(`We don't ship to ${country === "IN" && input.shippingAddress.postalCode ? `PIN ${input.shippingAddress.postalCode}` : country} yet`);
    const chosen = shippingRates.find((r) => r.id === input.shippingRateId) ?? (shippingRates.length === 1 ? shippingRates[0] : undefined);
    if (chosen && input.shippingAddress) {
      shippingLine = { id: chosen.id, title: chosen.title, amount: chosen.amount, discount: 0, kind: chosen.kind, provider: chosen.provider ?? null, carrierRateId: chosen.carrierRateId ?? null };
    }
  };

  // ── Discounts ──
  const discount: Pricing["discount"] = { code: null, applied: false, error: null, application: null };
  const applications: Pricing["discounts"] = [];
  const enteredCodes = [...(input.discountCodes ?? []), ...(input.discountCode?.trim() ? [input.discountCode.trim()] : [])];
  discount.code = enteredCodes[0] ?? null;

  if (input.manualDiscount && input.manualDiscount.value > 0) {
    await pickShipping(subtotal);
    const m = input.manualDiscount;
    const amount = Math.min(m.kind === "percentage" ? roundHalf((subtotal * Math.min(m.value, 10_000)) / 10_000) : m.value, subtotal);
    allocate(amount, lines.map((l) => l.subtotal)).forEach((a, i) => (lines[i]!.discountAmount = a));
    discount.applied = amount > 0;
    discount.application = { code: null, title: m.reason?.trim() || "Discount", kind: "manual", value: m.value, amount, discountId: null };
    applications.push({ ...discount.application, codeId: null });
  } else {
    const { candidates, errors } = lines.length
      ? await loadDiscountCandidates(db, storeId, enteredCodes, { email: input.customer?.email ?? null, customerId: input.customer?.id ?? null, at, excludeOrderId: input.orderId ?? null })
      : { candidates: [], errors: [] };
    // Shipping is quoted on the subtotal after product/order discounts (free-over thresholds);
    // a first pass without shipping gives that subtotal.
    const pass1 = applyDiscounts({ lines: engineLines, discounts: candidates, shippingAmount: null });
    const shippable = lines.reduce((s, l, i) => s + (l.requiresShipping ? l.subtotal - pass1.lineDiscounts[i]! : 0), 0);
    await pickShipping(shippable);
    const sl = shippingLine as ShippingLine | null;
    const result = applyDiscounts({ lines: engineLines, discounts: candidates, shippingAmount: sl ? sl.amount : null });
    result.lineDiscounts.forEach((a, i) => (lines[i]!.discountAmount = a));
    if (sl) sl.discount = result.shippingDiscount;
    for (const a of result.applications) {
      const c = candidates.find((x) => x.id === a.discount.id)!;
      applications.push({ code: c.code, title: c.title, kind: c.kind, value: c.value, amount: a.amount, discountId: c.id, codeId: c.codeId });
    }
    const codeError = [...errors, ...result.rejected][0];
    const codeApp = applications.find((a) => a.code && enteredCodes.some((e) => e.toLowerCase() === a.code!.toLowerCase()));
    if (codeApp) {
      discount.applied = true;
      discount.code = codeApp.code;
      discount.application = codeApp;
    } else if (codeError) discount.error = codeError.reason;
    // An automatic discount still counts as "a discount applied" for the totals view.
    if (!discount.application && applications[0]) discount.application = applications[0];
  }

  const finalShipping = shippingLine as ShippingLine | null;
  const orderDiscount = lines.reduce((s, l) => s + l.discountAmount, 0);
  const discountedSubtotal = subtotal - orderDiscount;
  const shippingTotal = finalShipping ? finalShipping.amount - finalShipping.discount : 0;

  // ── Tax ──
  const included = tax.pricesIncludeTax;
  const taxCtx = await loadTaxContext(db, storeId, tax, input.shippingAddress);
  for (const l of lines) {
    if (!l.taxable) continue;
    l.taxRateBps = rateForLine(taxCtx, l.collectionIds);
    l.taxAmount = taxOn(l.subtotal - l.discountAmount, l.taxRateBps, included);
    l.taxLines = splitTax(l.taxAmount, l.taxRateBps, tax, input.shippingAddress, taxCtx.baseName);
  }
  const shippingTax = tax.taxShipping ? taxOn(shippingTotal, taxCtx.baseRateBps, included) : 0;
  const taxLines = mergeTaxLines([...lines.map((l) => l.taxLines), splitTax(shippingTax, taxCtx.baseRateBps, tax, input.shippingAddress, taxCtx.baseName)]);
  const taxTotal = taxLines.reduce((s, t) => s + t.amount, 0);

  const discountTotal = orderDiscount + (finalShipping?.discount ?? 0);
  const total = discountedSubtotal + shippingTotal + (included ? 0 : taxTotal);

  // ── Gift cards ──
  const gc = input.giftCardCodes?.length ? await resolveGiftCards(db, storeId, input.giftCardCodes, currency, at) : { cards: [], errors: [] };
  const giftCardsApplied = applyGiftCardBalances(gc.cards, total);
  const giftCardTotal = giftCardsApplied.reduce((s, g) => s + g.amount, 0);

  if (lines.length === 0) blockers.push("Your cart is empty");
  if (discount.error && enteredCodes.length && !discount.applied) blockers.push(discount.error);
  for (const e of gc.errors) blockers.push(e.reason);

  return {
    currency,
    lines,
    unavailable,
    itemCount,
    subtotal,
    discountTotal,
    shippingTotal,
    taxTotal,
    total,
    taxesIncluded: included,
    taxLines,
    discount,
    discounts: applications,
    giftCards: giftCardsApplied,
    giftCardErrors: gc.errors.map((e) => e.reason),
    giftCardTotal,
    totalDue: total - giftCardTotal,
    weightGrams,
    shippingRequired,
    shippingRates,
    shippingLine: finalShipping,
    blockers,
  };
}
