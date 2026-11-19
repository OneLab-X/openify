import { describe, expect, it } from "vitest";
import { applyDiscounts, canCombine, classOf, type EngineDiscount, type EngineLine } from "../src/commerce/discount-engine.js";

const NONE = { product: false, order: false, shipping: false };
const ALL = { product: true, order: true, shipping: true };

let seq = 0;
function d(over: Partial<EngineDiscount>): EngineDiscount {
  seq++;
  return {
    id: `d${seq}`,
    title: over.title ?? `Discount ${seq}`,
    code: null,
    kind: "percentage",
    value: 1000,
    target: "all",
    productIds: [],
    collectionIds: [],
    perItem: false,
    bxgy: null,
    minSubtotal: null,
    minQuantity: null,
    maxShippingAmount: null,
    combinesWith: NONE,
    ...over,
  };
}

// Tee ₹500 ×2 (collection "tops"), mug ₹300 ×1 (collection "home"), cap ₹200 ×3 (tops), gift card ₹1000.
const TEE: EngineLine = { productId: "tee", collectionIds: ["tops"], unitPrice: 50_000, quantity: 2 };
const MUG: EngineLine = { productId: "mug", collectionIds: ["home"], unitPrice: 30_000, quantity: 1 };
const CAP: EngineLine = { productId: "cap", collectionIds: ["tops"], unitPrice: 20_000, quantity: 3 };
const CARD: EngineLine = { productId: "card", collectionIds: [], unitPrice: 100_000, quantity: 1, giftCard: true };
const CART = [TEE, MUG, CAP];

interface Case {
  name: string;
  lines?: EngineLine[];
  shipping?: number | null;
  discounts: EngineDiscount[];
  lineDiscounts: number[];
  shippingDiscount?: number;
  applied?: string[];
  rejected?: string[];
}

const cases: Case[] = [
  // ── Percentage ──
  { name: "10% off the order", discounts: [d({ title: "A", value: 1000 })], lineDiscounts: [10_000, 3_000, 6_000], applied: ["A"] },
  { name: "100% off is capped at the price", discounts: [d({ title: "A", value: 10_000 })], lineDiscounts: [100_000, 30_000, 60_000] },
  { name: "% off a collection", discounts: [d({ title: "A", value: 2500, target: "collections", collectionIds: ["tops"] })], lineDiscounts: [25_000, 0, 15_000] },
  { name: "% off specific products", discounts: [d({ title: "A", value: 5000, target: "products", productIds: ["mug"] })], lineDiscounts: [0, 15_000, 0] },
  { name: "rounding: 33.33% allocates exact paise", lines: [{ ...MUG, unitPrice: 999 }], discounts: [d({ value: 3333 })], lineDiscounts: [333] },
  { name: "gift cards are never discounted", lines: [TEE, CARD], discounts: [d({ value: 1000 })], lineDiscounts: [10_000, 0] },

  // ── Fixed amount ──
  { name: "₹100 off the order, allocated by line value", discounts: [d({ title: "A", kind: "fixed_amount", value: 10_000 })], lineDiscounts: [5_263, 1_579, 3_158] },
  { name: "fixed off never exceeds the subtotal", lines: [MUG], discounts: [d({ kind: "fixed_amount", value: 99_999 })], lineDiscounts: [30_000] },
  { name: "fixed off a collection, once across items", discounts: [d({ kind: "fixed_amount", value: 8_000, target: "collections", collectionIds: ["tops"] })], lineDiscounts: [5_000, 0, 3_000] },
  { name: "fixed off each eligible item", discounts: [d({ kind: "fixed_amount", value: 5_000, perItem: true, target: "collections", collectionIds: ["tops"] })], lineDiscounts: [10_000, 0, 15_000] },

  // ── Free shipping ──
  { name: "free shipping", shipping: 5_000, discounts: [d({ title: "S", kind: "free_shipping", value: 0 })], lineDiscounts: [0, 0, 0], shippingDiscount: 5_000, applied: ["S"] },
  { name: "free shipping only up to a rate cap", shipping: 15_000, discounts: [d({ title: "S", kind: "free_shipping", maxShippingAmount: 10_000 })], lineDiscounts: [0, 0, 0], shippingDiscount: 0, applied: [] },
  { name: "free-shipping code before a rate is chosen still shows as applied", shipping: null, discounts: [d({ title: "S", code: "SHIP", kind: "free_shipping" })], lineDiscounts: [0, 0, 0], shippingDiscount: 0, applied: ["S"] },

  // ── Buy X get Y ──
  {
    name: "buy 2 tops get 1 top free (cheapest unit free)",
    discounts: [d({ title: "B", kind: "buy_x_get_y", target: "all", bxgy: { buy: { quantity: 2, target: "collections", productIds: [], collectionIds: ["tops"] }, get: { quantity: 1, target: "collections", productIds: [], collectionIds: ["tops"], percentOff: 10_000 }, usesPerOrder: 1 } })],
    lineDiscounts: [0, 0, 20_000],
  },
  {
    name: "buy X get Y repeats up to the per-order limit",
    discounts: [d({ kind: "buy_x_get_y", bxgy: { buy: { quantity: 1, target: "collections", productIds: [], collectionIds: ["tops"] }, get: { quantity: 1, target: "collections", productIds: [], collectionIds: ["tops"], percentOff: 10_000 }, usesPerOrder: null } })],
    // 5 tops: two uses → the two cheapest caps free (buys are the tees + a cap).
    lineDiscounts: [0, 0, 40_000],
  },
  {
    name: "buy a tee get a mug at 50% off",
    discounts: [d({ kind: "buy_x_get_y", bxgy: { buy: { quantity: 1, target: "products", productIds: ["tee"], collectionIds: [] }, get: { quantity: 1, target: "products", productIds: ["mug"], collectionIds: [], percentOff: 5000 }, usesPerOrder: 1 } })],
    lineDiscounts: [0, 15_000, 0],
  },
  {
    name: "buy X get Y needs the buy items",
    lines: [MUG],
    discounts: [d({ kind: "buy_x_get_y", bxgy: { buy: { quantity: 1, target: "products", productIds: ["tee"], collectionIds: [] }, get: { quantity: 1, target: "products", productIds: ["mug"], collectionIds: [], percentOff: 10_000 }, usesPerOrder: 1 } })],
    lineDiscounts: [0],
  },

  // ── Minimum requirements ──
  { name: "min subtotal met", discounts: [d({ title: "A", value: 1000, minSubtotal: 190_000 })], lineDiscounts: [10_000, 3_000, 6_000] },
  { name: "min subtotal not met rejects a code", discounts: [d({ code: "BIG", value: 1000, minSubtotal: 500_000 })], lineDiscounts: [0, 0, 0], rejected: ["BIG"] },
  { name: "min quantity counts eligible items only", discounts: [d({ code: "TOPS5", value: 1000, target: "collections", collectionIds: ["tops"], minQuantity: 6 })], lineDiscounts: [0, 0, 0], rejected: ["TOPS5"] },
  { name: "a code for products not in the cart is rejected", discounts: [d({ code: "HATS", target: "products", productIds: ["hat"] })], lineDiscounts: [0, 0, 0], rejected: ["HATS"] },

  // ── Combination rules ──
  {
    name: "non-combinable: the bigger discount wins",
    discounts: [d({ title: "small", value: 500 }), d({ title: "big", value: 2000 })],
    lineDiscounts: [20_000, 6_000, 12_000],
    applied: ["big"],
  },
  {
    name: "a better non-combinable automatic beats an entered code (code rejected)",
    discounts: [d({ title: "auto", value: 2000 }), d({ title: "code", code: "TEN", value: 1000 })],
    lineDiscounts: [20_000, 6_000, 12_000],
    applied: ["auto"],
    rejected: ["TEN"],
  },
  {
    name: "on a tie the entered code wins",
    discounts: [d({ title: "auto", value: 1000 }), d({ title: "code", code: "TEN", value: 1000 })],
    lineDiscounts: [10_000, 3_000, 6_000],
    applied: ["code"],
  },
  {
    name: "product + order discounts combine when both allow; order applies on the reduced price",
    discounts: [
      d({ title: "tops", value: 5000, target: "collections", collectionIds: ["tops"], combinesWith: { product: false, order: true, shipping: false } }),
      d({ title: "order", value: 1000, combinesWith: { product: true, order: false, shipping: false } }),
    ],
    // tops 50% → tee 50,000 left, cap 30,000; then 10% of (50,000 + 30,000 mug + 30,000) = 11,000.
    lineDiscounts: [50_000 + 5_000, 3_000, 30_000 + 3_000],
    applied: ["tops", "order"],
  },
  {
    name: "one-sided permission is not enough",
    discounts: [
      d({ title: "tops", value: 5000, target: "collections", collectionIds: ["tops"], combinesWith: { product: false, order: true, shipping: false } }),
      d({ title: "order", value: 1000, combinesWith: NONE }),
    ],
    lineDiscounts: [50_000, 0, 30_000],
    applied: ["tops"],
  },
  {
    name: "order + shipping discounts combine",
    shipping: 5_000,
    discounts: [d({ title: "order", value: 1000, combinesWith: { product: false, order: false, shipping: true } }), d({ title: "ship", kind: "free_shipping", combinesWith: { product: false, order: true, shipping: false } })],
    lineDiscounts: [10_000, 3_000, 6_000],
    shippingDiscount: 5_000,
    applied: ["order", "ship"],
  },
  {
    name: "two order discounts stack when both allow order combinations",
    discounts: [d({ title: "a", value: 1000, combinesWith: { product: false, order: true, shipping: false } }), d({ title: "b", kind: "fixed_amount", value: 10_000, combinesWith: { product: false, order: true, shipping: false } })],
    lineDiscounts: [10_000 + 5_263, 3_000 + 1_579, 6_000 + 3_158],
    applied: ["a", "b"],
  },
  {
    name: "two product discounts on the same line apply one after the other",
    discounts: [
      d({ title: "p1", value: 5000, target: "products", productIds: ["tee"], combinesWith: { product: true, order: false, shipping: false } }),
      d({ title: "p2", value: 5000, target: "products", productIds: ["tee"], combinesWith: { product: true, order: false, shipping: false } }),
    ],
    lineDiscounts: [75_000, 0, 0],
    applied: ["p1", "p2"],
  },
  {
    name: "combined discounts never exceed the line price",
    discounts: [d({ title: "a", value: 8000, combinesWith: ALL }), d({ title: "b", kind: "fixed_amount", value: 1_000_000, combinesWith: ALL })],
    lineDiscounts: [100_000, 30_000, 60_000],
  },
  {
    name: "best combination beats the best single discount",
    shipping: 5_000,
    discounts: [
      d({ title: "solo", value: 1500 }),
      d({ title: "o", value: 1000, combinesWith: { product: false, order: false, shipping: true } }),
      d({ title: "s", kind: "free_shipping", combinesWith: { product: false, order: true, shipping: false } }),
    ],
    // solo = 28,500; o + s = 19,000 + 5,000 = 24,000 → solo still wins.
    lineDiscounts: [15_000, 4_500, 9_000],
    shippingDiscount: 0,
    applied: ["solo"],
  },
];

describe("discount engine", () => {
  it.each(cases)("$name", (c) => {
    const result = applyDiscounts({ lines: c.lines ?? CART, discounts: c.discounts, shippingAmount: c.shipping === undefined ? null : c.shipping });
    expect(result.lineDiscounts).toEqual(c.lineDiscounts);
    expect(result.shippingDiscount).toBe(c.shippingDiscount ?? 0);
    if (c.applied) expect(result.applications.map((a) => a.discount.title)).toEqual(c.applied);
    expect(result.rejected.map((r) => r.code)).toEqual(c.rejected ?? []);
    const total = result.applications.reduce((s, a) => s + a.amount, 0);
    expect(total).toBe(result.lineDiscounts.reduce((a, b) => a + b, 0) + result.shippingDiscount);
  });

  it.each([
    [{ kind: "percentage", target: "all" }, "order"],
    [{ kind: "fixed_amount", target: "all" }, "order"],
    [{ kind: "percentage", target: "collections" }, "product"],
    [{ kind: "fixed_amount", target: "products" }, "product"],
    [{ kind: "buy_x_get_y", target: "all" }, "product"],
    [{ kind: "free_shipping", target: "all" }, "shipping"],
  ] as const)("classifies %o as %s", (input, cls) => {
    expect(classOf(input)).toBe(cls);
  });

  it("combination needs both sides to allow the other's class", () => {
    const order = d({ combinesWith: { product: true, order: false, shipping: false } });
    const product = d({ target: "products", productIds: ["tee"], combinesWith: { product: false, order: true, shipping: false } });
    const shipping = d({ kind: "free_shipping", combinesWith: { product: true, order: true, shipping: false } });
    expect(canCombine(order, product)).toBe(true);
    expect(canCombine(order, shipping)).toBe(false);
    expect(canCombine(product, shipping)).toBe(false);
  });
});
