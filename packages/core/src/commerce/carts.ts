import { randomToken, sha256Hex } from "@shopkit/crypto";
import { and, asc, cartLines, carts, desc, eq, isNull, ne, type Executor } from "@shopkit/db";
import { z } from "zod";
import { mediaByIds, mediaView, type MediaView } from "../catalog/media-view.js";
import type { CoreDeps } from "../deps.js";
import { now } from "../deps.js";
import { AppError, notFound } from "../errors.js";
import { getStore } from "../stores.js";
import { MAX_LINE_QUANTITY, priceLines, type Pricing } from "./pricing.js";

/** Guest and customer carts (Phase 3 item 1). The cookie holds a random token; the DB its hash. */
export const MAX_CART_LINES = 100;

const attributesSchema = z
  .record(z.string().trim().min(1).max(100), z.string().max(500))
  .refine((r) => Object.keys(r).length <= 20, "Too many attributes")
  .default({});

export const addLinesInput = z.object({
  lines: z
    .array(z.object({ variantId: z.uuid(), quantity: z.number().int().min(1).max(MAX_LINE_QUANTITY).default(1), attributes: attributesSchema }))
    .min(1)
    .max(50),
});
export const updateLineInput = z.object({ quantity: z.number().int().min(0).max(MAX_LINE_QUANTITY) });
export const updateCartInput = z.object({
  note: z.string().max(2000).nullish(),
  attributes: attributesSchema.optional(),
  /** Empty string or null removes the code. */
  discountCode: z.string().trim().max(40).nullish(),
  /** Replaces the entered gift card codes (Phase 4). */
  giftCardCodes: z.array(z.string().trim().min(8).max(30)).max(5).optional(),
});

type CartRow = typeof carts.$inferSelect;

export async function findCart(db: Executor, storeId: string, token: string | undefined): Promise<CartRow | null> {
  if (!token || token.length > 100) return null;
  const [cart] = await db
    .select()
    .from(carts)
    .where(and(eq(carts.storeId, storeId), eq(carts.tokenHash, sha256Hex(token)), isNull(carts.completedAt)));
  return cart ?? null;
}

/** Returns the cookie's cart, creating one (and a new token) when there is none. */
export async function getOrCreateCart(deps: CoreDeps, storeId: string, token: string | undefined, customerId?: string | null) {
  const existing = await findCart(deps.db, storeId, token);
  if (existing) return { cart: existing, token: token!, created: false };
  const store = await getStore(deps.db, storeId);
  const fresh = randomToken(24);
  const [cart] = await deps.db
    .insert(carts)
    .values({ storeId, tokenHash: sha256Hex(fresh), currency: store.currency ?? "USD", customerId: customerId ?? null })
    .returning();
  return { cart: cart!, token: fresh, created: true };
}

async function cartLinesOf(db: Executor, cartId: string) {
  return db.select().from(cartLines).where(eq(cartLines.cartId, cartId)).orderBy(asc(cartLines.createdAt), asc(cartLines.id));
}

const sameAttributes = (a: Record<string, string>, b: Record<string, string>) => {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k] === b[k]);
};

/** Throws when the quantity cannot be sold (tracked, "deny" policy, not enough stock). */
async function assertSellable(db: Executor, storeId: string, variantId: string, quantity: number) {
  const pricing = await priceLines(db, storeId, { lines: [{ variantId, quantity }] });
  if (pricing.unavailable.length) throw new AppError("conflict", "This product is no longer available");
  const line = pricing.lines[0]!;
  if (line.stockIssue) {
    throw new AppError("conflict", line.availableQuantity! > 0 ? `Only ${line.availableQuantity} of ${line.title} left` : `${line.title} is sold out`, {
      available: line.availableQuantity,
    });
  }
}

async function touch(db: Executor, cartId: string) {
  await db.update(carts).set({ updatedAt: new Date() }).where(eq(carts.id, cartId));
}

export async function addCartLines(deps: CoreDeps, storeId: string, cart: CartRow, input: z.input<typeof addLinesInput>) {
  const { lines } = addLinesInput.parse(input);
  await deps.db.transaction(async (tx) => {
    await tx.select({ id: carts.id }).from(carts).where(eq(carts.id, cart.id)).for("update");
    const existing = await cartLinesOf(tx, cart.id);
    for (const l of lines) {
      const match = existing.find((e) => e.variantId === l.variantId && sameAttributes(e.attributes, l.attributes));
      const quantity = Math.min((match?.quantity ?? 0) + l.quantity, MAX_LINE_QUANTITY);
      await assertSellable(tx, storeId, l.variantId, quantity);
      if (match) {
        await tx.update(cartLines).set({ quantity }).where(eq(cartLines.id, match.id));
        match.quantity = quantity;
      } else {
        if (existing.length >= MAX_CART_LINES) throw new AppError("validation_failed", "Your cart is full");
        const [row] = await tx.insert(cartLines).values({ storeId, cartId: cart.id, variantId: l.variantId, quantity, attributes: l.attributes }).returning();
        existing.push(row!);
      }
    }
    await touch(tx, cart.id);
  });
}

export async function updateCartLine(deps: CoreDeps, storeId: string, cart: CartRow, lineId: string, input: z.input<typeof updateLineInput>) {
  const { quantity } = updateLineInput.parse(input);
  await deps.db.transaction(async (tx) => {
    const [line] = await tx.select().from(cartLines).where(and(eq(cartLines.cartId, cart.id), eq(cartLines.id, lineId)));
    if (!line) throw notFound("Cart line");
    if (quantity === 0) await tx.delete(cartLines).where(eq(cartLines.id, lineId));
    else {
      if (quantity > line.quantity) await assertSellable(tx, storeId, line.variantId, quantity);
      await tx.update(cartLines).set({ quantity }).where(eq(cartLines.id, lineId));
    }
    await touch(tx, cart.id);
  });
}

export async function updateCart(deps: CoreDeps, cart: CartRow, input: z.input<typeof updateCartInput>) {
  const data = updateCartInput.parse(input);
  const set: Partial<typeof carts.$inferInsert> = { updatedAt: new Date() };
  if (data.note !== undefined) set.note = data.note?.trim() || null;
  if (data.attributes !== undefined) set.attributes = data.attributes;
  if (data.discountCode !== undefined) set.discountCode = data.discountCode?.trim() || null;
  if (data.giftCardCodes !== undefined) set.giftCardCodes = [...new Set(data.giftCardCodes.map((c) => c.toUpperCase()))];
  await deps.db.update(carts).set(set).where(eq(carts.id, cart.id));
}

export interface CartLineView {
  id: string;
  variantId: string;
  productId: string;
  productHandle: string;
  title: string;
  variantTitle: string | null;
  sku: string | null;
  quantity: number;
  unitPrice: number;
  compareAtPrice: number | null;
  subtotal: number;
  discountAmount: number;
  attributes: Record<string, string>;
  image: MediaView | null;
  availableQuantity: number | null;
  stockIssue: string | null;
}

export async function linesWithImages(deps: CoreDeps, pricing: Pricing): Promise<CartLineView[]> {
  const images = await mediaByIds(deps.db, pricing.lines.map((l) => l.imageMediaId).filter((x): x is string => !!x));
  return pricing.lines.map((l) => {
    const img = l.imageMediaId ? images.get(l.imageMediaId) : undefined;
    return {
      id: l.ref ?? l.variantId,
      variantId: l.variantId,
      productId: l.productId,
      productHandle: l.productHandle,
      title: l.title,
      variantTitle: l.variantTitle,
      sku: l.sku,
      quantity: l.quantity,
      unitPrice: l.unitPrice,
      compareAtPrice: l.compareAtPrice,
      subtotal: l.subtotal,
      discountAmount: l.discountAmount,
      attributes: l.attributes,
      image: img ? mediaView(deps, img) : null,
      availableQuantity: l.availableQuantity,
      stockIssue: l.stockIssue,
    };
  });
}

/** Cart as the storefront sees it, priced by the shared pricing service (no address yet). */
export async function cartView(deps: CoreDeps, storeId: string, cart: CartRow, customer?: { id?: string | null; email?: string | null }) {
  const rows = await cartLinesOf(deps.db, cart.id);
  const pricing = await priceLines(deps.db, storeId, {
    lines: rows.map((r) => ({ variantId: r.variantId, quantity: r.quantity, attributes: r.attributes, ref: r.id })),
    discountCode: cart.discountCode,
    giftCardCodes: cart.giftCardCodes,
    customer: customer ?? { id: cart.customerId },
    at: now(deps),
  });
  return {
    id: cart.id,
    currency: pricing.currency,
    note: cart.note,
    attributes: cart.attributes,
    lines: await linesWithImages(deps, pricing),
    unavailable: pricing.unavailable.map((u) => ({ lineId: u.ref, variantId: u.variantId, reason: u.reason })),
    itemCount: pricing.itemCount,
    subtotal: pricing.subtotal,
    discountTotal: pricing.discountTotal,
    taxTotal: pricing.taxTotal,
    total: pricing.total,
    taxesIncluded: pricing.taxesIncluded,
    discount: { code: pricing.discount.code, applied: pricing.discount.applied, error: pricing.discount.error, amount: pricing.discount.application?.amount ?? 0 },
    discounts: pricing.discounts.map((d) => ({ code: d.code, title: d.title, amount: d.amount })),
    giftCards: pricing.giftCards.map((g) => ({ lastCharacters: g.lastCharacters, amount: g.amount })),
    giftCardErrors: pricing.giftCardErrors,
    giftCardTotal: pricing.giftCardTotal,
    totalDue: pricing.totalDue,
    updatedAt: cart.updatedAt.toISOString(),
  };
}
export type CartView = Awaited<ReturnType<typeof cartView>>;

export const emptyCartView = (currency: string): CartView => ({
  id: "",
  currency,
  note: null,
  attributes: {},
  lines: [],
  unavailable: [],
  itemCount: 0,
  subtotal: 0,
  discountTotal: 0,
  taxTotal: 0,
  total: 0,
  taxesIncluded: false,
  discount: { code: null, applied: false, error: null, amount: 0 },
  discounts: [],
  giftCards: [],
  giftCardErrors: [],
  giftCardTotal: 0,
  totalDue: 0,
  updatedAt: new Date(0).toISOString(),
});

/**
 * At sign-in: the cookie cart becomes the customer's, and lines from their previous open cart are
 * merged into it (quantities add up). With no cookie cart, the previous cart is adopted under a new
 * token (only token hashes are stored, so the old token cannot be handed back).
 */
export async function mergeCartOnLogin(deps: CoreDeps, storeId: string, token: string | undefined, customerId: string): Promise<{ token: string | null }> {
  return deps.db.transaction(async (tx) => {
    const current = await findCart(tx, storeId, token);
    const [previous] = await tx
      .select()
      .from(carts)
      .where(and(eq(carts.storeId, storeId), eq(carts.customerId, customerId), isNull(carts.completedAt), current ? ne(carts.id, current.id) : undefined))
      .orderBy(desc(carts.updatedAt))
      .limit(1);
    if (!current) {
      if (!previous) return { token: null };
      const fresh = randomToken(24);
      await tx.update(carts).set({ tokenHash: sha256Hex(fresh), updatedAt: new Date() }).where(eq(carts.id, previous.id));
      return { token: fresh };
    }
    await tx.update(carts).set({ customerId, updatedAt: new Date() }).where(eq(carts.id, current.id));
    if (previous) {
      const mine = await cartLinesOf(tx, current.id);
      for (const line of await cartLinesOf(tx, previous.id)) {
        const match = mine.find((m) => m.variantId === line.variantId && sameAttributes(m.attributes, line.attributes));
        if (match) {
          match.quantity = Math.min(match.quantity + line.quantity, MAX_LINE_QUANTITY);
          await tx.update(cartLines).set({ quantity: match.quantity }).where(eq(cartLines.id, match.id));
        } else if (mine.length < MAX_CART_LINES) {
          await tx.update(cartLines).set({ cartId: current.id }).where(eq(cartLines.id, line.id));
          mine.push(line);
        }
      }
      if (!current.note && previous.note) await tx.update(carts).set({ note: previous.note }).where(eq(carts.id, current.id));
      await tx.update(carts).set({ completedAt: new Date(), mergedIntoId: current.id }).where(eq(carts.id, previous.id));
    }
    return { token: token! };
  });
}
