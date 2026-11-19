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
import { getSetting } from "../settings.js";
import { getStore } from "../stores.js";
import { resolveDiscountCode, type ResolvedDiscount } from "./discounts.js";

/**
 * The single pricing function (SPEC §1.6, Phase 3): cart, checkout, order creation and draft orders
 * all call `priceLines`. Every amount comes from the database; the browser only sends variant ids,
 * quantities and choices. Discounts are allocated to lines before tax so tax is on the discounted
 * price; rounding is per line, half away from zero, in integer minor units.
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
  discountCode?: string | null;
  /** Draft orders: a staff-entered order discount instead of a code. */
  manualDiscount?: { kind: "percentage" | "fixed_amount"; value: number; reason?: string | null } | null;
  /** Draft orders: a staff-entered shipping charge (null = none) instead of the store rates. */
  customShipping?: { title: string; amount: number } | null;
  customer?: { id?: string | null; email?: string | null };
  /** The order being re-priced, so its own discount use does not count against "once per customer". */
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
  requiresShipping: boolean;
  taxable: boolean;
  attributes: Record<string, string>;
  inventoryItemId: string | null;
  tracked: boolean;
  inventoryPolicy: "deny" | "continue";
  /** Sum of `available` across active locations (tracked items only). */
  availableQuantity: number | null;
  /** Customer-facing stock problem, if any. */
  stockIssue: string | null;
}

export interface ShippingRateOption {
  id: string;
  title: string;
  amount: number;
}

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
  discount: { code: string | null; applied: boolean; error: string | null; application: DiscountApplication | null; resolved: ResolvedDiscount | null };
  shippingRequired: boolean;
  shippingRates: ShippingRateOption[];
  shippingLine: ShippingLine | null;
  /** Problems that must be fixed before payment. */
  blockers: string[];
}

export const MAX_LINE_QUANTITY = 999;

/** Rounds half away from zero (integer minor units never become fractional). */
export const roundHalf = (n: number) => Math.sign(n) * Math.round(Math.abs(n));

/** Splits `total` across `weights` proportionally; remainders go to the largest fractions first. */
export function allocate(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (total <= 0 || sum <= 0) return weights.map(() => 0);
  const exact = weights.map((w) => (total * w) / sum);
  const out = exact.map(Math.floor);
  let rest = total - out.reduce((a, b) => a + b, 0);
  const order = exact.map((e, i) => [e - Math.floor(e), i] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (const [, i] of order) {
    if (rest <= 0) break;
    out[i]! += 1;
    rest -= 1;
  }
  return out;
}

interface TaxConfig {
  mode: "india_gst" | "generic";
  pricesIncludeTax: boolean;
  defaultRateBps: number;
  registeredState?: string | undefined;
  label?: string | undefined;
  taxShipping?: boolean | undefined;
}

function taxOn(base: number, rateBps: number, included: boolean): number {
  if (base <= 0 || rateBps <= 0) return 0;
  return roundHalf(included ? (base * rateBps) / (10_000 + rateBps) : (base * rateBps) / 10_000);
}

const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

/** Names and splits one tax amount: GST → CGST+SGST within the registered state, IGST across states. */
function taxLinesFor(amount: number, cfg: TaxConfig, address: MailingAddress | null | undefined): TaxLine[] {
  const rate = cfg.defaultRateBps;
  if (amount === 0 || rate === 0) return [];
  if (cfg.mode === "india_gst") {
    if (address && cfg.registeredState && address.country === "IN") {
      if (norm(address.province) === norm(cfg.registeredState)) {
        const cgst = Math.floor(amount / 2);
        return [
          { title: "CGST", rateBps: rate / 2, amount: cgst },
          { title: "SGST", rateBps: rate / 2, amount: amount - cgst },
        ];
      }
      return [{ title: "IGST", rateBps: rate, amount }];
    }
    return [{ title: "GST", rateBps: rate, amount }];
  }
  return [{ title: cfg.label?.trim() || "Tax", rateBps: rate, amount }];
}

function mergeTaxLines(lists: TaxLine[][]): TaxLine[] {
  const map = new Map<string, TaxLine>();
  for (const l of lists.flat()) {
    const key = `${l.title}:${l.rateBps}`;
    const prev = map.get(key);
    map.set(key, prev ? { ...prev, amount: prev.amount + l.amount } : { ...l });
  }
  return [...map.values()];
}

/** Loads the variants and their stock in one round trip. */
async function loadVariants(db: Executor, storeId: string, variantIds: string[]) {
  const rows = variantIds.length === 0 ? [] : await db
    .select({
      variantId: productVariants.id,
      productId: products.id,
      handle: products.handle,
      productTitle: products.title,
      status: products.status,
      featuredMediaId: products.featuredMediaId,
      variantTitle: productVariants.title,
      price: productVariants.price,
      compareAtPrice: productVariants.compareAtPrice,
      sku: productVariants.sku,
      hsnCode: productVariants.hsnCode,
      requiresShipping: productVariants.requiresShipping,
      taxable: productVariants.taxable,
      inventoryPolicy: productVariants.inventoryPolicy,
      imageMediaId: productVariants.imageMediaId,
      inventoryItemId: inventoryItems.id,
      tracked: inventoryItems.tracked,
      available: sql<number | null>`(select sum(${inventoryLevels.available})::int from ${inventoryLevels}
        join ${locations} on ${locations.id} = ${inventoryLevels.locationId} and ${locations.active}
        where ${inventoryLevels.inventoryItemId} = ${inventoryItems.id})`,
    })
    .from(productVariants)
    .innerJoin(products, eq(products.id, productVariants.productId))
    .leftJoin(inventoryItems, eq(inventoryItems.variantId, productVariants.id))
    .where(and(eq(productVariants.storeId, storeId), inArray(productVariants.id, variantIds)));
  return new Map(rows.map((r) => [r.variantId, r]));
}

export async function priceLines(db: Executor, storeId: string, input: PricingInput): Promise<Pricing> {
  const at = input.at ?? new Date();
  const store = await getStore(db, storeId);
  const currency = store.currency ?? "USD";
  const [tax, shippingCfg] = await Promise.all([getSetting(db, storeId, "tax.config"), getSetting(db, storeId, "shipping.defaults")]);
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
      requiresShipping: v.requiresShipping,
      taxable: v.taxable,
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

  // ── Discount ──
  const discount: Pricing["discount"] = { code: input.discountCode?.trim() || null, applied: false, error: null, application: null, resolved: null };
  let orderDiscount = 0;
  let freeShipping = false;
  if (input.manualDiscount && input.manualDiscount.value > 0) {
    const m = input.manualDiscount;
    orderDiscount = m.kind === "percentage" ? roundHalf((subtotal * Math.min(m.value, 10_000)) / 10_000) : Math.min(m.value, subtotal);
    discount.applied = orderDiscount > 0;
    discount.application = { code: null, title: m.reason?.trim() || "Discount", kind: "manual", value: m.value, amount: orderDiscount, discountId: null };
  } else if (discount.code && lines.length > 0) {
    const resolved = await resolveDiscountCode(db, storeId, discount.code, {
      subtotal,
      email: input.customer?.email ?? null,
      customerId: input.customer?.id ?? null,
      at,
      excludeOrderId: input.orderId ?? null,
    });
    if (!resolved.ok) discount.error = resolved.error;
    else {
      const d = resolved.value.discount;
      discount.resolved = resolved.value;
      discount.code = resolved.value.code;
      if (d.kind === "percentage") orderDiscount = roundHalf((subtotal * d.value) / 10_000);
      else if (d.kind === "fixed_amount") orderDiscount = Math.min(d.value, subtotal);
      else freeShipping = true;
      discount.applied = true;
      discount.application = { code: resolved.value.code, title: d.title, kind: d.kind, value: d.value, amount: orderDiscount, discountId: d.id };
    }
  }
  orderDiscount = Math.min(orderDiscount, subtotal);
  const shares = allocate(orderDiscount, lines.map((l) => l.subtotal));
  lines.forEach((l, i) => (l.discountAmount = shares[i]!));
  const discountedSubtotal = subtotal - orderDiscount;

  // ── Shipping ──
  const shippingRequired = lines.some((l) => l.requiresShipping);
  let shippingRates: ShippingRateOption[] = [];
  let shippingLine: ShippingLine | null = null;
  if (input.customShipping !== undefined) {
    if (input.customShipping) {
      const amount = Math.max(0, Math.trunc(input.customShipping.amount));
      shippingLine = { id: "custom", title: input.customShipping.title || "Shipping", amount, discount: 0 };
      shippingRates = [{ id: "custom", title: shippingLine.title, amount }];
    }
  } else if (shippingRequired) {
    const country = input.shippingAddress?.country?.toUpperCase();
    const ships = shippingCfg.countries.length === 0 || !country || shippingCfg.countries.includes(country);
    if (!ships) blockers.push(`We don't ship to ${country} yet`);
    else {
      const free = shippingCfg.freeOver !== null && discountedSubtotal >= shippingCfg.freeOver;
      shippingRates = [{ id: "standard", title: shippingCfg.rateName || "Standard", amount: free ? 0 : shippingCfg.rateAmount }];
    }
    const chosen = shippingRates.find((r) => r.id === input.shippingRateId) ?? (shippingRates.length === 1 ? shippingRates[0] : undefined);
    if (chosen && input.shippingAddress) shippingLine = { id: chosen.id, title: chosen.title, amount: chosen.amount, discount: 0 };
  }
  if (shippingLine && freeShipping) {
    shippingLine.discount = shippingLine.amount;
    if (discount.application) discount.application.amount = shippingLine.amount;
  }
  const shippingTotal = shippingLine ? shippingLine.amount - shippingLine.discount : 0;

  // ── Tax ──
  const included = tax.pricesIncludeTax;
  for (const l of lines) {
    if (!l.taxable) continue;
    l.taxAmount = taxOn(l.subtotal - l.discountAmount, tax.defaultRateBps, included);
    l.taxLines = taxLinesFor(l.taxAmount, tax, input.shippingAddress);
  }
  const shippingTax = tax.taxShipping ? taxOn(shippingTotal, tax.defaultRateBps, included) : 0;
  const taxLines = mergeTaxLines([...lines.map((l) => l.taxLines), taxLinesFor(shippingTax, tax, input.shippingAddress)]);
  const taxTotal = taxLines.reduce((s, t) => s + t.amount, 0);

  const discountTotal = orderDiscount + (shippingLine?.discount ?? 0);
  const total = discountedSubtotal + shippingTotal + (included ? 0 : taxTotal);

  if (lines.length === 0) blockers.push("Your cart is empty");
  if (discount.error && discount.code) blockers.push(discount.error);

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
    shippingRequired,
    shippingRates,
    shippingLine,
    blockers,
  };
}
