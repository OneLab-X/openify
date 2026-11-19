import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  char,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { citext, createdAt, pk, updatedAt } from "./columns.js";
import { productVariants, products } from "./catalog.js";
import { customers } from "./customers.js";
import { inventoryItems } from "./inventory.js";
import { staffUsers } from "./staff.js";
import { locations, stores } from "./stores.js";

const storeRef = () =>
  uuid()
    .notNull()
    .references(() => stores.id, { onDelete: "cascade" });
const money = () => bigint({ mode: "number" });

/** Postal address on carts/checkouts/orders (a snapshot, not a reference). */
export interface MailingAddress {
  firstName?: string | null;
  lastName?: string | null;
  company?: string | null;
  line1: string;
  line2?: string | null;
  city: string;
  province?: string | null;
  postalCode?: string | null;
  /** ISO 3166-1 alpha-2. */
  country: string;
  phone?: string | null;
}

export interface TaxLine {
  title: string;
  /** Basis points: 1800 = 18%. */
  rateBps: number;
  amount: number;
}

export interface ShippingLine {
  id: string;
  title: string;
  amount: number;
  discount: number;
  /** Phase 4: rate kind, carrier provider and the carrier's quoted rate id. */
  kind?: string;
  provider?: string | null;
  carrierRateId?: string | null;
}

export interface DiscountApplication {
  code: string | null;
  title: string;
  kind: "percentage" | "fixed_amount" | "free_shipping" | "buy_x_get_y" | "manual";
  value: number;
  amount: number;
  discountId: string | null;
  codeId?: string | null;
}

export interface OrderTotals {
  subtotal: number;
  discountTotal: number;
  shippingTotal: number;
  taxTotal: number;
  total: number;
  taxesIncluded: boolean;
}

// ── Carts ────────────────────────────────────────────────────────────────────
/** Guest or customer cart. The cookie holds a random token; only its SHA-256 is stored. */
export const carts = pgTable(
  "carts",
  {
    id: pk(),
    storeId: storeRef(),
    tokenHash: text().notNull(),
    customerId: uuid().references(() => customers.id, { onDelete: "set null" }),
    currency: char({ length: 3 }).notNull(),
    note: text(),
    attributes: jsonb().$type<Record<string, string>>().notNull().default({}),
    discountCode: citext(),
    /** Gift card codes the shopper entered (Phase 4); balances are checked at pricing time. */
    giftCardCodes: text().array().notNull().default(sql`'{}'::text[]`),
    /** Set when the cart becomes an order, or when it was merged into another cart at login. */
    completedAt: timestamp({ withTimezone: true }),
    mergedIntoId: uuid(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("carts_token_uq").on(t.tokenHash),
    index("carts_customer_idx").on(t.storeId, t.customerId).where(sql`${t.completedAt} is null`),
  ],
);

export const cartLines = pgTable(
  "cart_lines",
  {
    id: pk(),
    storeId: storeRef(),
    cartId: uuid()
      .notNull()
      .references(() => carts.id, { onDelete: "cascade" }),
    variantId: uuid()
      .notNull()
      .references(() => productVariants.id, { onDelete: "cascade" }),
    quantity: integer().notNull(),
    /** Line item properties (engraving text, gift message…). */
    attributes: jsonb().$type<Record<string, string>>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("cart_lines_cart_idx").on(t.cartId, t.createdAt)],
);

// ── Checkouts ────────────────────────────────────────────────────────────────
export const checkoutStatus = pgEnum("checkout_status", ["open", "completed"]);

/**
 * One per cart. Holds contact, address and choices between steps; totals are always recomputed by
 * the pricing service. Abandoned-checkout state lives here (`abandoned_notified_at`) instead of a
 * separate `abandoned_checkouts` table (DECISIONS.md).
 */
export const checkouts = pgTable(
  "checkouts",
  {
    id: pk(),
    storeId: storeRef(),
    cartId: uuid()
      .notNull()
      .references(() => carts.id, { onDelete: "cascade" }),
    customerId: uuid().references(() => customers.id, { onDelete: "set null" }),
    status: checkoutStatus().notNull().default("open"),
    email: citext(),
    phone: text(),
    marketingConsent: boolean().notNull().default(false),
    shippingAddress: jsonb().$type<MailingAddress>(),
    billingAddress: jsonb().$type<MailingAddress>(),
    shippingRateId: text(),
    paymentProvider: text(),
    /** Optional buyer GSTIN / VAT id for the invoice. */
    buyerTaxId: text(),
    /** Last computed totals, for the abandoned-checkout email and admin. */
    totals: jsonb().$type<OrderTotals>(),
    orderId: uuid(),
    abandonedNotifiedAt: timestamp({ withTimezone: true }),
    completedAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("checkouts_cart_uq").on(t.cartId),
    index("checkouts_abandoned_idx")
      .on(t.storeId, t.updatedAt)
      .where(sql`${t.status} = 'open' and ${t.email} is not null and ${t.abandonedNotifiedAt} is null`),
  ],
);

// ── Orders ───────────────────────────────────────────────────────────────────
export const orderStatus = pgEnum("order_status", ["open", "closed", "cancelled"]);
export const financialStatus = pgEnum("financial_status", [
  "pending",
  "authorized",
  "paid",
  "partially_paid",
  "partially_refunded",
  "refunded",
  "voided",
]);
export const fulfillmentStatus = pgEnum("fulfillment_status", ["unfulfilled", "partially_fulfilled", "fulfilled", "returned"]);
export const inventoryState = pgEnum("order_inventory_state", ["none", "reserved", "released"]);

/**
 * SPEC §8 orders. A row is created at payment-session time (`placed_at` null, no number yet) so the
 * provider can reference it; it gets its number and appears in the admin when it is placed (paid,
 * or confirmed for manual/COD payments). Unplaced rows whose reservation expired are abandoned
 * checkouts, not orders.
 */
export const orders = pgTable(
  "orders",
  {
    id: pk(),
    storeId: storeRef(),
    number: integer(),
    /** Prefix + number, e.g. PLS-1001. */
    name: text(),
    checkoutId: uuid().references(() => checkouts.id, { onDelete: "set null" }),
    customerId: uuid().references(() => customers.id, { onDelete: "set null" }),
    email: citext(),
    phone: text(),
    currency: char({ length: 3 }).notNull(),
    subtotal: money().notNull(),
    discountTotal: money().notNull().default(0),
    shippingTotal: money().notNull().default(0),
    taxTotal: money().notNull().default(0),
    total: money().notNull(),
    taxesIncluded: boolean().notNull().default(false),
    amountPaid: money().notNull().default(0),
    amountRefunded: money().notNull().default(0),
    /** Part of `total` paid with gift cards (Phase 4); included in amountPaid once redeemed. */
    giftCardTotal: money().notNull().default(0),
    buyerTaxId: text(),
    taxLines: jsonb().$type<TaxLine[]>().notNull().default([]),
    discountApplications: jsonb().$type<DiscountApplication[]>().notNull().default([]),
    shippingLine: jsonb().$type<ShippingLine | null>(),
    shippingAddress: jsonb().$type<MailingAddress>(),
    billingAddress: jsonb().$type<MailingAddress>(),
    note: text(),
    attributes: jsonb().$type<Record<string, string>>().notNull().default({}),
    tags: text().array().notNull().default(sql`'{}'::text[]`),
    status: orderStatus().notNull().default("open"),
    financialStatus: financialStatus().notNull().default("pending"),
    fulfillmentStatus: fulfillmentStatus().notNull().default("unfulfilled"),
    inventoryState: inventoryState().notNull().default("none"),
    reservationExpiresAt: timestamp({ withTimezone: true }),
    paymentProvider: text(),
    paymentMode: text().$type<"test" | "live">(),
    sourceName: text().$type<"web" | "admin" | "draft">().notNull().default("web"),
    marketingConsent: boolean().notNull().default(false),
    placedAt: timestamp({ withTimezone: true }),
    cancelledAt: timestamp({ withTimezone: true }),
    cancelReason: text(),
    closedAt: timestamp({ withTimezone: true }),
    createdBy: uuid().references(() => staffUsers.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("orders_store_number_uq").on(t.storeId, t.number),
    index("orders_store_placed_idx").on(t.storeId, t.placedAt.desc(), t.id.desc()).where(sql`${t.placedAt} is not null`),
    index("orders_customer_idx").on(t.customerId, t.placedAt.desc()),
    index("orders_checkout_idx").on(t.checkoutId),
  ],
);

/** Per-store counters for order and draft-order numbers (row-locked increments). */
export const orderSequences = pgTable("order_sequences", {
  storeId: uuid()
    .primaryKey()
    .references(() => stores.id, { onDelete: "cascade" }),
  nextOrder: integer().notNull().default(1001),
  nextDraft: integer().notNull().default(1),
  nextInvoice: integer().notNull().default(1),
});

export const orderLines = pgTable(
  "order_lines",
  {
    id: pk(),
    storeId: storeRef(),
    orderId: uuid()
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    variantId: uuid().references(() => productVariants.id, { onDelete: "set null" }),
    productId: uuid().references(() => products.id, { onDelete: "set null" }),
    inventoryItemId: uuid().references(() => inventoryItems.id, { onDelete: "set null" }),
    /** Location the quantity was reserved at (null when inventory is not tracked). */
    locationId: uuid().references(() => locations.id, { onDelete: "set null" }),
    title: text().notNull(),
    variantTitle: text(),
    sku: text(),
    hsnCode: text(),
    quantity: integer().notNull(),
    unitPrice: money().notNull(),
    compareAtPrice: money(),
    /** Share of order-level discounts allocated to this line. */
    discountAmount: money().notNull().default(0),
    taxAmount: money().notNull().default(0),
    taxLines: jsonb().$type<TaxLine[]>().notNull().default([]),
    requiresShipping: boolean().notNull().default(true),
    taxable: boolean().notNull().default(true),
    attributes: jsonb().$type<Record<string, string>>().notNull().default({}),
    restockedQuantity: integer().notNull().default(0),
    refundedQuantity: integer().notNull().default(0),
    fulfilledQuantity: integer().notNull().default(0),
    returnedQuantity: integer().notNull().default(0),
    /** Shipped units refunded without coming back (customer kept them); not returnable. */
    keptQuantity: integer().notNull().default(0),
    /** Gift card product line: cards are issued when the order is paid. */
    giftCard: boolean().notNull().default(false),
    position: integer().notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index("order_lines_order_idx").on(t.orderId, t.position)],
);

/** Order timeline: system events and staff comments. */
export const orderEvents = pgTable(
  "order_events",
  {
    id: pk(),
    storeId: storeRef(),
    orderId: uuid()
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    type: text().notNull(),
    message: text().notNull(),
    data: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    actorType: text().$type<"staff" | "customer" | "system" | "provider" | "api_key">().notNull(),
    actorId: uuid(),
    createdAt: createdAt(),
  },
  (t) => [index("order_events_order_idx").on(t.orderId, t.createdAt)],
);

// ── Payments ─────────────────────────────────────────────────────────────────
/**
 * Each provider session created for an order (a shopper may switch methods). Lets late webhooks
 * for an older session still find their order. Not in SPEC §8; see DECISIONS.md.
 */
export const paymentSessions = pgTable(
  "payment_sessions",
  {
    id: pk(),
    storeId: storeRef(),
    orderId: uuid()
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    provider: text().notNull(),
    mode: text().$type<"test" | "live">().notNull(),
    providerOrderId: text(),
    amount: money().notNull(),
    currency: char({ length: 3 }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("payment_sessions_order_idx").on(t.orderId),
    index("payment_sessions_provider_idx").on(t.provider, t.providerOrderId),
  ],
);

export const transactionKind = pgEnum("transaction_kind", ["authorization", "capture", "sale", "refund", "void"]);
export const transactionStatus = pgEnum("transaction_status", ["pending", "success", "failure"]);

export const transactions = pgTable(
  "transactions",
  {
    id: pk(),
    storeId: storeRef(),
    orderId: uuid()
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    kind: transactionKind().notNull(),
    status: transactionStatus().notNull(),
    amount: money().notNull(),
    currency: char({ length: 3 }).notNull(),
    /** Provider id, or "manual" for payments recorded by staff. */
    provider: text().notNull(),
    mode: text().$type<"test" | "live">(),
    /** Provider payment id (captures) or refund id (refunds); the idempotency key per kind. */
    providerReference: text(),
    providerOrderId: text(),
    method: text(),
    errorMessage: text(),
    parentId: uuid(),
    createdBy: uuid(),
    processedAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index("transactions_order_idx").on(t.orderId, t.createdAt),
    uniqueIndex("transactions_reference_uq").on(t.storeId, t.provider, t.kind, t.providerReference),
  ],
);

/** SPEC §7 step 4: one row per provider event id; a duplicate insert means "already handled". */
export const paymentWebhookEvents = pgTable(
  "payment_webhook_events",
  {
    id: pk(),
    storeId: storeRef(),
    provider: text().notNull(),
    eventId: text().notNull(),
    type: text().notNull(),
    orderId: uuid(),
    outcome: text(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("payment_webhook_events_uq").on(t.storeId, t.provider, t.eventId)],
);

export const refundStatus = pgEnum("refund_status", ["pending", "success", "failure"]);

export const refunds = pgTable(
  "refunds",
  {
    id: pk(),
    storeId: storeRef(),
    orderId: uuid()
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    /** Total refunded to the customer (lines + shipping + adjustment). */
    amount: money().notNull(),
    /** Part of `amount` that refunds shipping. */
    shippingAmount: money().notNull().default(0),
    /** Pending until the provider confirms (synchronously or by webhook); amounts count on success. */
    status: refundStatus().notNull().default("success"),
    returnId: uuid(),
    currency: char({ length: 3 }).notNull(),
    reason: text(),
    note: text(),
    restock: boolean().notNull().default(false),
    transactionId: uuid(),
    createdBy: uuid(),
    createdAt: createdAt(),
  },
  (t) => [index("refunds_order_idx").on(t.orderId)],
);

export const refundLines = pgTable(
  "refund_lines",
  {
    id: pk(),
    storeId: storeRef(),
    refundId: uuid()
      .notNull()
      .references(() => refunds.id, { onDelete: "cascade" }),
    orderLineId: uuid()
      .notNull()
      .references(() => orderLines.id, { onDelete: "cascade" }),
    quantity: integer().notNull(),
    restock: boolean().notNull().default(false),
  },
  (t) => [index("refund_lines_refund_idx").on(t.refundId)],
);

// ── Draft orders ─────────────────────────────────────────────────────────────
export interface DraftLine {
  variantId: string;
  quantity: number;
}

export const draftOrderStatus = pgEnum("draft_order_status", ["open", "completed"]);

export const draftOrders = pgTable(
  "draft_orders",
  {
    id: pk(),
    storeId: storeRef(),
    number: integer().notNull(),
    name: text().notNull(),
    status: draftOrderStatus().notNull().default("open"),
    customerId: uuid().references(() => customers.id, { onDelete: "set null" }),
    email: citext(),
    phone: text(),
    lines: jsonb().$type<DraftLine[]>().notNull().default([]),
    shippingAddress: jsonb().$type<MailingAddress>(),
    /** Custom shipping charge chosen by staff; null = no shipping. */
    shippingLine: jsonb().$type<{ title: string; amount: number } | null>(),
    discount: jsonb().$type<{ kind: "percentage" | "fixed_amount"; value: number; reason?: string } | null>(),
    note: text(),
    tags: text().array().notNull().default(sql`'{}'::text[]`),
    orderId: uuid().references(() => orders.id, { onDelete: "set null" }),
    createdBy: uuid().references(() => staffUsers.id, { onDelete: "set null" }),
    completedAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("draft_orders_store_number_uq").on(t.storeId, t.number), index("draft_orders_store_idx").on(t.storeId, t.createdAt.desc())],
);

// ── Discounts (basic codes; Phase 4 extends) ─────────────────────────────────
export const discountKind = pgEnum("discount_kind", ["percentage", "fixed_amount", "free_shipping", "buy_x_get_y"]);
export const discountMethod = pgEnum("discount_method", ["code", "automatic"]);
export const discountTarget = pgEnum("discount_target", ["all", "collections", "products"]);
export const discountEligibility = pgEnum("discount_eligibility", ["all", "customers", "tags"]);

/** Which other discount classes a discount may combine with (Shopify's product/order/shipping classes). */
export interface DiscountCombines {
  product: boolean;
  order: boolean;
  shipping: boolean;
}

/** Buy X get Y: the "customer buys" requirement and the "customer gets" reward. */
export interface BuyXGetY {
  buy: { quantity: number; target: "all" | "collections" | "products"; productIds: string[]; collectionIds: string[] };
  get: { quantity: number; target: "all" | "collections" | "products"; productIds: string[]; collectionIds: string[]; /** 10000 = free. */ percentOff: number };
  /** Max times the reward applies per order (null = unlimited). */
  usesPerOrder: number | null;
}
export const discountStatus = pgEnum("discount_status", ["active", "disabled"]);

export const discounts = pgTable(
  "discounts",
  {
    id: pk(),
    storeId: storeRef(),
    title: text().notNull(),
    method: discountMethod().notNull().default("code"),
    kind: discountKind().notNull(),
    /** Basis points for percentage, minor units for fixed_amount, unused for free_shipping. */
    value: integer().notNull().default(0),
    target: discountTarget().notNull().default("all"),
    productIds: uuid().array().notNull().default(sql`'{}'::uuid[]`),
    collectionIds: uuid().array().notNull().default(sql`'{}'::uuid[]`),
    /** fixed_amount on products: true = the amount off each eligible item, false = once across them. */
    perItem: boolean().notNull().default(false),
    bxgy: jsonb().$type<BuyXGetY | null>(),
    minSubtotal: money(),
    minQuantity: integer(),
    /** free_shipping: only when the shipping rate is at most this (null = any). */
    maxShippingAmount: money(),
    eligibility: discountEligibility().notNull().default("all"),
    customerIds: uuid().array().notNull().default(sql`'{}'::uuid[]`),
    customerTags: text().array().notNull().default(sql`'{}'::text[]`),
    usageLimitPerCustomer: integer(),
    combinesWith: jsonb().$type<DiscountCombines>().notNull().default({ product: false, order: false, shipping: false }),
    startsAt: timestamp({ withTimezone: true }),
    endsAt: timestamp({ withTimezone: true }),
    usageLimit: integer(),
    oncePerCustomer: boolean().notNull().default(false),
    status: discountStatus().notNull().default("active"),
    usageCount: integer().notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("discounts_store_idx").on(t.storeId, t.createdAt.desc()), index("discounts_automatic_idx").on(t.storeId).where(sql`${t.method} = 'automatic' and ${t.status} = 'active'`)],
);

export const discountCodes = pgTable(
  "discount_codes",
  {
    id: pk(),
    storeId: storeRef(),
    discountId: uuid()
      .notNull()
      .references(() => discounts.id, { onDelete: "cascade" }),
    code: citext().notNull(),
    usageCount: integer().notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("discount_codes_store_code_uq").on(t.storeId, t.code)],
);

export const discountUsages = pgTable(
  "discount_usages",
  {
    id: pk(),
    storeId: storeRef(),
    discountId: uuid()
      .notNull()
      .references(() => discounts.id, { onDelete: "cascade" }),
    codeId: uuid().references(() => discountCodes.id, { onDelete: "set null" }),
    orderId: uuid()
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    email: citext(),
    customerId: uuid(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("discount_usages_order_uq").on(t.discountId, t.orderId), index("discount_usages_email_idx").on(t.discountId, t.email)],
);

// ── Email log ────────────────────────────────────────────────────────────────
/**
 * One row per idempotency key (order id + template). The email job claims the row before sending,
 * so a retried or duplicated job never sends twice. Not in SPEC §8; see DECISIONS.md.
 */
export const emailDeliveries = pgTable(
  "email_deliveries",
  {
    id: pk(),
    storeId: storeRef(),
    idempotencyKey: text().notNull(),
    template: text().notNull(),
    to: citext().notNull(),
    status: text().$type<"sending" | "sent" | "failed">().notNull(),
    providerMessageId: text(),
    error: text(),
    attempts: integer().notNull().default(0),
    orderId: uuid(),
    sentAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("email_deliveries_key_uq").on(t.storeId, t.idempotencyKey), index("email_deliveries_order_idx").on(t.orderId)],
);
