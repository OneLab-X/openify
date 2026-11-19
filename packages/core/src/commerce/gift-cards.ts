import { createHash, randomInt } from "node:crypto";
import { and, asc, desc, eq, giftCardTransactions, giftCards, inArray, orderLines, sql, transactions, type Executor } from "@shopkit/db";
import { z } from "zod";
import { writeAudit } from "../audit.js";
import type { Actor, CoreDeps } from "../deps.js";
import { now } from "../deps.js";
import { AppError, notFound } from "../errors.js";
import { enqueueEvent } from "../outbox.js";
import { getStore } from "../stores.js";

/**
 * Gift cards (Phase 4). A code is shown once (issue email / admin) and stored as SHA-256 plus its
 * last 4 characters. Every balance change is a ledger row; `balance` is the row-locked running
 * total. At checkout, cards are debited when the order is created for payment and credited back
 * if that order is re-priced, abandoned or refunded.
 */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export const normalizeGiftCode = (code: string) => code.replace(/[\s-]/g, "").toUpperCase();
export const hashGiftCode = (code: string) => createHash("sha256").update(normalizeGiftCode(code)).digest("hex");

export function generateGiftCode(): string {
  const raw = Array.from({ length: 16 }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
  return raw.match(/.{4}/g)!.join("-");
}

type GiftCardRow = typeof giftCards.$inferSelect;
type Who = { type: "staff" | "customer" | "system"; id?: string | null };

export function giftCardView(g: GiftCardRow, at: Date = new Date()) {
  const expired = !!g.expiresAt && g.expiresAt <= at;
  return {
    id: g.id,
    lastCharacters: g.lastCharacters,
    maskedCode: `••••-••••-••••-${g.lastCharacters}`,
    currency: g.currency,
    initialValue: g.initialValue,
    balance: g.balance,
    customerId: g.customerId,
    orderId: g.orderId,
    recipientEmail: g.recipientEmail,
    note: g.note,
    expiresAt: g.expiresAt?.toISOString() ?? null,
    disabledAt: g.disabledAt?.toISOString() ?? null,
    status: g.disabledAt ? ("disabled" as const) : expired ? ("expired" as const) : g.balance === 0 ? ("used" as const) : ("active" as const),
    createdAt: g.createdAt.toISOString(),
  };
}

async function insertCard(tx: Executor, storeId: string, input: { value: number; currency: string; customerId?: string | null; recipientEmail?: string | null; note?: string | null; expiresAt?: Date | null; orderId?: string | null; orderLineId?: string | null; createdBy?: string | null }, who: Who) {
  const code = generateGiftCode();
  const [card] = await tx
    .insert(giftCards)
    .values({
      storeId,
      codeHash: hashGiftCode(code),
      lastCharacters: normalizeGiftCode(code).slice(-4),
      currency: input.currency,
      initialValue: input.value,
      balance: input.value,
      customerId: input.customerId ?? null,
      recipientEmail: input.recipientEmail ?? null,
      note: input.note ?? null,
      expiresAt: input.expiresAt ?? null,
      orderId: input.orderId ?? null,
      orderLineId: input.orderLineId ?? null,
      createdBy: input.createdBy ?? null,
    })
    .returning();
  await tx.insert(giftCardTransactions).values({ storeId, giftCardId: card!.id, kind: "issue", amount: input.value, balanceAfter: input.value, orderId: input.orderId ?? null, actorType: who.type, actorId: who.id ?? null });
  return { card: card!, code };
}

export const issueGiftCardInput = z.object({
  value: z.number().int().min(1).max(100_000_000),
  customerId: z.uuid().nullish(),
  recipientEmail: z.email().nullish(),
  note: z.string().trim().max(500).nullish(),
  expiresAt: z.coerce.date().nullish(),
  notify: z.boolean().default(true),
});

/** Staff issues a card. Returns the full code once. */
export async function issueGiftCard(deps: CoreDeps, actor: Actor, storeId: string, input: z.input<typeof issueGiftCardInput>) {
  const d = issueGiftCardInput.parse(input);
  const store = await getStore(deps.db, storeId);
  return deps.db.transaction(async (tx) => {
    const { card, code } = await insertCard(tx, storeId, { ...d, currency: store.currency ?? "USD", createdBy: actor.id ?? null }, { type: "staff", id: actor.id ?? null });
    if (d.notify && d.recipientEmail) await enqueueEvent(tx, { storeId, type: "gift_card.issued", payload: { giftCardId: card.id, code, email: d.recipientEmail } });
    await writeAudit(tx, actor, { storeId, action: "gift_card.issued", resourceType: "gift_card", resourceId: card.id, metadata: { value: d.value } });
    return { ...giftCardView(card), code };
  });
}

/**
 * Gift card product lines on a paid order: one card per unit, worth the line's unit price. The
 * unique (orderLineId, lastCharacters) index plus the per-line count keep this idempotent.
 */
export async function issueGiftCardsForOrder(tx: Executor, storeId: string, order: { id: string; currency: string; email: string | null; customerId: string | null }) {
  const lines = await tx.select().from(orderLines).where(and(eq(orderLines.orderId, order.id), eq(orderLines.giftCard, true)));
  for (const line of lines) {
    const [have] = await tx.select({ n: sql<number>`count(*)::int` }).from(giftCards).where(eq(giftCards.orderLineId, line.id));
    for (let i = have?.n ?? 0; i < line.quantity - line.refundedQuantity; i++) {
      const value = line.unitPrice - Math.floor(line.discountAmount / line.quantity);
      const { card, code } = await insertCard(tx, storeId, { value, currency: order.currency, customerId: order.customerId, recipientEmail: line.attributes["Recipient email"] ?? order.email, orderId: order.id, orderLineId: line.id }, { type: "system" });
      const to = card.recipientEmail ?? order.email;
      if (to) await enqueueEvent(tx, { storeId, type: "gift_card.issued", payload: { giftCardId: card.id, code, email: to, orderId: order.id } });
    }
  }
}

export async function listGiftCards(db: Executor, storeId: string, q: { query?: string; limit?: number } = {}) {
  const last = q.query ? normalizeGiftCode(q.query).slice(-4) : null;
  const rows = await db
    .select()
    .from(giftCards)
    .where(and(eq(giftCards.storeId, storeId), last ? eq(giftCards.lastCharacters, last) : undefined))
    .orderBy(desc(giftCards.createdAt))
    .limit(Math.min(q.limit ?? 100, 250));
  return rows.map((g) => giftCardView(g));
}

export async function getGiftCard(db: Executor, storeId: string, id: string) {
  const [g] = await db.select().from(giftCards).where(and(eq(giftCards.storeId, storeId), eq(giftCards.id, id)));
  if (!g) throw notFound("Gift card");
  const ledger = await db.select().from(giftCardTransactions).where(eq(giftCardTransactions.giftCardId, id)).orderBy(asc(giftCardTransactions.createdAt));
  return {
    ...giftCardView(g),
    transactions: ledger.map((t) => ({ id: t.id, kind: t.kind, amount: t.amount, balanceAfter: t.balanceAfter, orderId: t.orderId, note: t.note, createdAt: t.createdAt.toISOString() })),
  };
}

export const updateGiftCardInput = z.object({
  disabled: z.boolean().optional(),
  expiresAt: z.coerce.date().nullish(),
  note: z.string().trim().max(500).nullish(),
  /** Signed balance adjustment in minor units. */
  adjustment: z.number().int().optional(),
  adjustmentNote: z.string().trim().max(200).optional(),
});

export async function updateGiftCard(deps: CoreDeps, actor: Actor, storeId: string, id: string, input: z.input<typeof updateGiftCardInput>) {
  const d = updateGiftCardInput.parse(input);
  await deps.db.transaction(async (tx) => {
    const [g] = await tx.select().from(giftCards).where(and(eq(giftCards.storeId, storeId), eq(giftCards.id, id))).for("update");
    if (!g) throw notFound("Gift card");
    const set: Partial<GiftCardRow> = {};
    if (d.disabled !== undefined) set.disabledAt = d.disabled ? (g.disabledAt ?? now(deps)) : null;
    if (d.expiresAt !== undefined) set.expiresAt = d.expiresAt ?? null;
    if (d.note !== undefined) set.note = d.note ?? null;
    if (d.adjustment) {
      const balance = g.balance + d.adjustment;
      if (balance < 0) throw new AppError("validation_failed", "The balance cannot go below zero");
      set.balance = balance;
      await tx.insert(giftCardTransactions).values({ storeId, giftCardId: id, kind: "adjust", amount: d.adjustment, balanceAfter: balance, note: d.adjustmentNote ?? null, actorType: "staff", actorId: actor.id ?? null });
    }
    if (Object.keys(set).length) await tx.update(giftCards).set(set).where(eq(giftCards.id, id));
    await writeAudit(tx, actor, { storeId, action: "gift_card.updated", resourceType: "gift_card", resourceId: id, metadata: { adjustment: d.adjustment ?? 0 } });
  });
}

export interface AppliedGiftCard {
  id: string;
  lastCharacters: string;
  amount: number;
  balance: number;
}

/** Looks up entered codes for pricing. Unknown/unusable codes come back as errors. */
export async function resolveGiftCards(db: Executor, storeId: string, codes: readonly string[], currency: string, at: Date) {
  const wanted = [...new Set(codes.map(normalizeGiftCode).filter((c) => c.length >= 8))];
  if (wanted.length === 0) return { cards: [] as GiftCardRow[], errors: [] as { code: string; reason: string }[] };
  const rows = await db.select().from(giftCards).where(and(eq(giftCards.storeId, storeId), inArray(giftCards.codeHash, wanted.map(hashGiftCode))));
  const cards: GiftCardRow[] = [];
  const errors: { code: string; reason: string }[] = [];
  for (const code of wanted) {
    const g = rows.find((r) => r.codeHash === hashGiftCode(code));
    const label = `Gift card ending ${code.slice(-4)}`;
    if (!g) errors.push({ code, reason: `${label} is not valid` });
    else if (g.disabledAt) errors.push({ code, reason: `${label} is disabled` });
    else if (g.expiresAt && g.expiresAt <= at) errors.push({ code, reason: `${label} has expired` });
    else if (g.currency !== currency) errors.push({ code, reason: `${label} is in ${g.currency}` });
    else if (g.balance <= 0) errors.push({ code, reason: `${label} has no balance left` });
    else cards.push(g);
  }
  return { cards, errors };
}

/** How much of `due` the cards cover, in the order entered. */
export function applyGiftCardBalances(cards: readonly Pick<GiftCardRow, "id" | "lastCharacters" | "balance">[], due: number): AppliedGiftCard[] {
  let left = Math.max(0, due);
  const out: AppliedGiftCard[] = [];
  for (const c of cards) {
    const amount = Math.min(c.balance, left);
    left -= amount;
    out.push({ id: c.id, lastCharacters: c.lastCharacters, amount, balance: c.balance });
  }
  return out;
}

/** Credits back everything an order took from gift cards that has not been returned yet. */
export async function reverseGiftCardRedemptions(tx: Executor, storeId: string, orderId: string, who: Who, note: string): Promise<number> {
  const rows = await tx
    .select({ cardId: giftCardTransactions.giftCardId, net: sql<number>`sum(${giftCardTransactions.amount})::bigint` })
    .from(giftCardTransactions)
    .where(and(eq(giftCardTransactions.orderId, orderId), inArray(giftCardTransactions.kind, ["redeem", "reverse", "refund"])))
    .groupBy(giftCardTransactions.giftCardId);
  let total = 0;
  for (const r of rows) {
    const owed = -Number(r.net);
    if (owed > 0) {
      total += owed;
      await creditCard(tx, storeId, r.cardId, owed, "reverse", orderId, who, note);
    }
  }
  return total;
}

async function creditCard(tx: Executor, storeId: string, cardId: string, amount: number, kind: "reverse" | "refund", orderId: string, who: Who, note: string) {
  const [g] = await tx.select().from(giftCards).where(eq(giftCards.id, cardId)).for("update");
  const balance = g!.balance + amount;
  await tx.update(giftCards).set({ balance }).where(eq(giftCards.id, cardId));
  await tx.insert(giftCardTransactions).values({ storeId, giftCardId: cardId, kind, amount, balanceAfter: balance, orderId, note, actorType: who.type, actorId: who.id ?? null });
}

/**
 * Debits the cards for an order being sent to payment (after reversing any earlier attempt).
 * Balances are re-checked under row locks; returns the total actually taken.
 */
export async function redeemGiftCards(tx: Executor, storeId: string, orderId: string, applied: readonly AppliedGiftCard[], who: Who): Promise<number> {
  await reverseGiftCardRedemptions(tx, storeId, orderId, who, "Checkout re-priced");
  let taken = 0;
  for (const a of applied) {
    if (a.amount <= 0) continue;
    const [g] = await tx.select().from(giftCards).where(eq(giftCards.id, a.id)).for("update");
    if (!g || g.disabledAt || g.balance < a.amount) throw new AppError("conflict", `Gift card ending ${a.lastCharacters} no longer has enough balance`);
    const balance = g.balance - a.amount;
    await tx.update(giftCards).set({ balance }).where(eq(giftCards.id, a.id));
    await tx.insert(giftCardTransactions).values({ storeId, giftCardId: a.id, kind: "redeem", amount: -a.amount, balanceAfter: balance, orderId, actorType: who.type, actorId: who.id ?? null });
    taken += a.amount;
  }
  return taken;
}

/** Refunds up to `amount` back onto the cards an order used (most recent redemption first). */
export async function refundToGiftCards(tx: Executor, storeId: string, orderId: string, amount: number, who: Who): Promise<number> {
  const rows = await tx
    .select({ cardId: giftCardTransactions.giftCardId, net: sql<number>`sum(${giftCardTransactions.amount})::bigint` })
    .from(giftCardTransactions)
    .where(and(eq(giftCardTransactions.orderId, orderId), inArray(giftCardTransactions.kind, ["redeem", "reverse", "refund"])))
    .groupBy(giftCardTransactions.giftCardId);
  let left = amount;
  for (const r of rows) {
    const owed = Math.min(-Number(r.net), left);
    if (owed <= 0) continue;
    await creditCard(tx, storeId, r.cardId, owed, "refund", orderId, who, "Order refund");
    left -= owed;
  }
  return amount - left;
}

/** Records the gift-card part of a placed order as a sale transaction (idempotent). */
export async function recordGiftCardSale(tx: Executor, storeId: string, order: { id: string; currency: string; giftCardTotal: number }, at: Date): Promise<boolean> {
  if (order.giftCardTotal <= 0) return false;
  const inserted = await tx
    .insert(transactions)
    .values({ storeId, orderId: order.id, kind: "sale", status: "success", amount: order.giftCardTotal, currency: order.currency, provider: "gift_card", mode: "live", providerReference: `gift_card:${order.id}`, method: "gift_card", processedAt: at })
    .onConflictDoNothing()
    .returning({ id: transactions.id });
  return inserted.length > 0;
}
