/**
 * Discount engine (Phase 4). Pure: given priced lines, the shipping charge and the candidate
 * discounts (already filtered for status, schedule, customer eligibility and usage limits by
 * `discounts.ts`), it picks the best allowed combination and allocates every amount to lines.
 *
 * Classes follow Shopify: product discounts (anything targeting products/collections, and buy X
 * get Y), order discounts (% or fixed off the whole order) and shipping discounts. Two discounts
 * can be applied together only when each allows the other's class. Product discounts apply first,
 * order discounts on what remains, shipping last. All amounts are integer minor units.
 */
import type { BuyXGetY, DiscountCombines } from "@shopkit/db";

export type DiscountClass = "product" | "order" | "shipping";
export type DiscountKind = "percentage" | "fixed_amount" | "free_shipping" | "buy_x_get_y";
export type Target = "all" | "collections" | "products";

export interface EngineLine {
  productId: string;
  collectionIds: readonly string[];
  unitPrice: number;
  quantity: number;
  /** Gift cards are never discounted. */
  giftCard?: boolean;
}

export interface EngineDiscount {
  id: string;
  title: string;
  /** Null for automatic discounts. */
  code: string | null;
  kind: DiscountKind;
  /** Basis points (percentage) or minor units (fixed_amount). */
  value: number;
  target: Target;
  productIds: readonly string[];
  collectionIds: readonly string[];
  perItem: boolean;
  bxgy: BuyXGetY | null;
  minSubtotal: number | null;
  minQuantity: number | null;
  maxShippingAmount: number | null;
  combinesWith: DiscountCombines;
}

export interface EngineInput {
  lines: readonly EngineLine[];
  discounts: readonly EngineDiscount[];
  /** Chosen shipping charge, or null when none is chosen yet. */
  shippingAmount: number | null;
}

export interface EngineApplication {
  discount: EngineDiscount;
  class: DiscountClass;
  /** Total amount off (line amounts + shipping). */
  amount: number;
  lineAmounts: number[];
  shippingAmount: number;
}

export interface EngineResult {
  applications: EngineApplication[];
  /** Per input line, the sum of all applications. */
  lineDiscounts: number[];
  shippingDiscount: number;
  /** Codes that were entered and valid but not applied, with a customer-facing reason. */
  rejected: { code: string; reason: string }[];
}

export const roundHalf = (n: number) => Math.sign(n) * Math.round(Math.abs(n));

/** Splits `total` across `weights` proportionally; remainders go to the largest fractions first. */
export function allocate(total: number, weights: readonly number[]): number[] {
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

export function classOf(d: Pick<EngineDiscount, "kind" | "target">): DiscountClass {
  if (d.kind === "free_shipping") return "shipping";
  if (d.kind === "buy_x_get_y" || d.target !== "all") return "product";
  return "order";
}

export function canCombine(a: EngineDiscount, b: EngineDiscount): boolean {
  return a.combinesWith[classOf(b)] && b.combinesWith[classOf(a)];
}

function matches(line: EngineLine, target: Target, productIds: readonly string[], collectionIds: readonly string[]): boolean {
  if (line.giftCard) return false;
  if (target === "all") return true;
  if (target === "products") return productIds.includes(line.productId);
  return line.collectionIds.some((c) => collectionIds.includes(c));
}

const label = (d: EngineDiscount) => (d.code ? d.code.toUpperCase() : d.title);

/** Whether the discount's minimum requirement is met (on the items it applies to). */
export function requirementMet(d: EngineDiscount, lines: readonly EngineLine[]): string | null {
  const eligible = lines.filter((l) => matches(l, d.target, d.productIds, d.collectionIds));
  const qty = eligible.reduce((s, l) => s + l.quantity, 0);
  const subtotal = eligible.reduce((s, l) => s + l.unitPrice * l.quantity, 0);
  if (d.kind !== "free_shipping" && d.kind !== "buy_x_get_y" && qty === 0) return `${label(d)} doesn't apply to the items in your cart`;
  if (d.minSubtotal !== null && subtotal < d.minSubtotal) return `${label(d)} needs a higher order subtotal`;
  if (d.minQuantity !== null && qty < d.minQuantity) return `${label(d)} needs at least ${d.minQuantity} items`;
  return null;
}

/** Units of each line, cheapest first, for buy X get Y. */
interface Unit {
  line: number;
  price: number;
}

function bxgyAmounts(d: EngineDiscount, lines: readonly EngineLine[], remaining: readonly number[]): number[] {
  const out = lines.map(() => 0);
  const rule = d.bxgy;
  if (!rule || rule.buy.quantity < 1 || rule.get.quantity < 1) return out;
  // Remaining per-unit price (after earlier product discounts) keeps allocations exact.
  const unitsOf = (i: number): Unit[] => {
    const l = lines[i]!;
    const shares = allocate(remaining[i]!, Array.from({ length: l.quantity }, () => 1));
    return shares.map((price) => ({ line: i, price }));
  };
  const all = lines.flatMap((_, i) => unitsOf(i));
  const isBuy = (u: Unit) => matches(lines[u.line]!, rule.buy.target, rule.buy.productIds, rule.buy.collectionIds);
  const isGet = (u: Unit) => matches(lines[u.line]!, rule.get.target, rule.get.productIds, rule.get.collectionIds);
  const used = new Set<Unit>();
  const pct = Math.min(Math.max(rule.get.percentOff, 0), 10_000);
  let uses = 0;
  for (;;) {
    if (rule.usesPerOrder !== null && uses >= rule.usesPerOrder) break;
    // The reward goes to the cheapest qualifying units; the requirement uses the dearest others.
    const gets = all.filter((u) => !used.has(u) && isGet(u)).sort((a, b) => a.price - b.price).slice(0, rule.get.quantity);
    if (gets.length < rule.get.quantity) break;
    const buys = all
      .filter((u) => !used.has(u) && !gets.includes(u) && isBuy(u))
      .sort((a, b) => b.price - a.price)
      .slice(0, rule.buy.quantity);
    if (buys.length < rule.buy.quantity) break;
    for (const u of [...gets, ...buys]) used.add(u);
    for (const u of gets) out[u.line]! += roundHalf((u.price * pct) / 10_000);
    uses++;
  }
  return out;
}

/** Amount each line (and shipping) gets from one discount, given what is left to discount. */
function evaluate(d: EngineDiscount, lines: readonly EngineLine[], remaining: readonly number[], shipping: number | null, shippingLeft: number): { lineAmounts: number[]; shippingAmount: number } {
  const zero = lines.map(() => 0);
  switch (d.kind) {
    case "free_shipping": {
      if (shipping === null) return { lineAmounts: zero, shippingAmount: 0 };
      if (d.maxShippingAmount !== null && shipping > d.maxShippingAmount) return { lineAmounts: zero, shippingAmount: 0 };
      return { lineAmounts: zero, shippingAmount: shippingLeft };
    }
    case "buy_x_get_y":
      return { lineAmounts: bxgyAmounts(d, lines, remaining), shippingAmount: 0 };
    case "percentage": {
      const weights = lines.map((l, i) => (matches(l, d.target, d.productIds, d.collectionIds) ? remaining[i]! : 0));
      const base = weights.reduce((a, b) => a + b, 0);
      const pct = Math.min(Math.max(d.value, 0), 10_000);
      return { lineAmounts: allocate(roundHalf((base * pct) / 10_000), weights), shippingAmount: 0 };
    }
    case "fixed_amount": {
      const weights = lines.map((l, i) => (matches(l, d.target, d.productIds, d.collectionIds) ? remaining[i]! : 0));
      if (d.perItem && d.target !== "all") {
        return { lineAmounts: lines.map((l, i) => (weights[i]! > 0 ? Math.min(weights[i]!, d.value * l.quantity) : 0)), shippingAmount: 0 };
      }
      const base = weights.reduce((a, b) => a + b, 0);
      return { lineAmounts: allocate(Math.min(d.value, base), weights), shippingAmount: 0 };
    }
  }
}

const CLASS_ORDER: Record<DiscountClass, number> = { product: 0, order: 1, shipping: 2 };

/** Applies a set of discounts in class order and returns the applications. */
function applySet(set: readonly EngineDiscount[], input: EngineInput): EngineApplication[] {
  const remaining = input.lines.map((l) => l.unitPrice * l.quantity);
  let shippingLeft = input.shippingAmount ?? 0;
  const ordered = [...set].sort((a, b) => CLASS_ORDER[classOf(a)] - CLASS_ORDER[classOf(b)]);
  const apps: EngineApplication[] = [];
  for (const d of ordered) {
    const r = evaluate(d, input.lines, remaining, input.shippingAmount, shippingLeft);
    const lineAmounts = r.lineAmounts.map((a, i) => Math.min(a, remaining[i]!));
    lineAmounts.forEach((a, i) => (remaining[i]! -= a));
    const shippingAmount = Math.min(r.shippingAmount, shippingLeft);
    shippingLeft -= shippingAmount;
    apps.push({ discount: d, class: classOf(d), amount: lineAmounts.reduce((a, b) => a + b, 0) + shippingAmount, lineAmounts, shippingAmount });
  }
  return apps;
}

const MAX_EXHAUSTIVE = 10;

/** Picks the combination with the largest total saving (ties: more entered codes, then more discounts). */
export function applyDiscounts(input: EngineInput): EngineResult {
  const rejected: EngineResult["rejected"] = [];
  const candidates: EngineDiscount[] = [];
  for (const d of input.discounts) {
    const problem = requirementMet(d, input.lines);
    if (problem) {
      if (d.code) rejected.push({ code: d.code, reason: problem });
      continue;
    }
    candidates.push(d);
  }

  let best: EngineApplication[] = [];
  let bestScore: [number, number, number] = [-1, -1, -1];
  const consider = (set: EngineDiscount[]) => {
    const apps = applySet(set, input);
    const total = apps.reduce((s, a) => s + a.amount, 0);
    const score: [number, number, number] = [total, set.filter((d) => d.code).length, set.length];
    if (score[0] > bestScore[0] || (score[0] === bestScore[0] && (score[1] > bestScore[1] || (score[1] === bestScore[1] && score[2] > bestScore[2])))) {
      best = apps;
      bestScore = score;
    }
  };

  if (candidates.length <= MAX_EXHAUSTIVE) {
    const n = candidates.length;
    for (let mask = 0; mask < 1 << n; mask++) {
      const set = candidates.filter((_, i) => mask & (1 << i));
      if (set.every((a, i) => set.every((b, j) => i >= j || canCombine(a, b)))) consider(set);
    }
  } else {
    // Greedy fallback: biggest standalone saving first.
    const standalone = candidates
      .map((d) => ({ d, v: applySet([d], input)[0]!.amount }))
      .sort((a, b) => b.v - a.v);
    const set: EngineDiscount[] = [];
    for (const { d } of standalone) if (set.every((s) => canCombine(s, d))) set.push(d);
    consider(set);
  }

  const chosen = new Set(best.map((a) => a.discount.id));
  for (const d of candidates) {
    if (d.code && !chosen.has(d.id)) rejected.push({ code: d.code, reason: `${label(d)} can't be combined with other discounts in your cart` });
  }
  // Drop zero-value automatic discounts from the output; keep codes so the shopper sees "applied".
  const applications = best.filter((a) => a.amount > 0 || a.discount.code);
  const lineDiscounts = input.lines.map((_, i) => applications.reduce((s, a) => s + a.lineAmounts[i]!, 0));
  return { applications, lineDiscounts, shippingDiscount: applications.reduce((s, a) => s + a.shippingAmount, 0), rejected };
}
