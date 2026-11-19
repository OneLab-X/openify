import { sql } from "drizzle-orm";
import { bigint, boolean, char, date, index, integer, jsonb, pgEnum, pgTable, primaryKey, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { citext, createdAt, pk, updatedAt } from "./columns.js";
import { collections } from "./catalog.js";
import { customers } from "./customers.js";
import { draftOrders, orderLines, orders, refunds } from "./commerce.js";
import { roles, staffUsers } from "./staff.js";
import { locations, stores } from "./stores.js";

const storeRef = () =>
  uuid()
    .notNull()
    .references(() => stores.id, { onDelete: "cascade" });
const money = () => bigint({ mode: "number" });

// ── Shipping zones and rates (SPEC §8 pricing) ───────────────────────────────
export const shippingZones = pgTable(
  "shipping_zones",
  {
    id: pk(),
    storeId: storeRef(),
    name: text().notNull(),
    position: integer().notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("shipping_zones_store_idx").on(t.storeId, t.position)],
);

/**
 * A country in a zone, optionally narrowed to states/provinces and postal-code prefixes (empty
 * arrays = the whole country). The most specific matching row wins across zones.
 */
export const shippingZoneCountries = pgTable(
  "shipping_zone_countries",
  {
    id: pk(),
    storeId: storeRef(),
    zoneId: uuid()
      .notNull()
      .references(() => shippingZones.id, { onDelete: "cascade" }),
    /** ISO 3166-1 alpha-2, or "*" for rest of world. */
    country: char({ length: 2 }).notNull(),
    provinces: text().array().notNull().default(sql`'{}'::text[]`),
    postalPrefixes: text().array().notNull().default(sql`'{}'::text[]`),
  },
  (t) => [index("shipping_zone_countries_zone_idx").on(t.zoneId), index("shipping_zone_countries_store_idx").on(t.storeId, t.country)],
);

export const shippingRateKind = pgEnum("shipping_rate_kind", ["flat", "weight", "price", "carrier", "local_pickup", "local_delivery"]);

export const shippingRates = pgTable(
  "shipping_rates",
  {
    id: pk(),
    storeId: storeRef(),
    /** Null for local pickup (offered regardless of zone). */
    zoneId: uuid().references(() => shippingZones.id, { onDelete: "cascade" }),
    name: text().notNull(),
    description: text(),
    kind: shippingRateKind().notNull(),
    /** Price charged (minor units). Carrier rates add it as a handling fee. */
    amount: money().notNull().default(0),
    /** weight: grams; price: minor units of the discounted subtotal. Inclusive min, exclusive max. */
    minValue: money(),
    maxValue: money(),
    /** Free when the discounted subtotal reaches this (null = never). */
    freeOver: money(),
    /** local_delivery: postal-code prefixes served. */
    postalPrefixes: text().array().notNull().default(sql`'{}'::text[]`),
    /** local_pickup: where the customer collects. */
    locationId: uuid().references(() => locations.id, { onDelete: "cascade" }),
    /** carrier: shipping provider id (shiprocket, delhivery, easypost). */
    provider: text(),
    active: boolean().notNull().default(true),
    position: integer().notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("shipping_rates_store_idx").on(t.storeId, t.zoneId, t.position)],
);

// ── Fulfillments ─────────────────────────────────────────────────────────────
export const fulfillmentStatusEnum = pgEnum("fulfillment_state", ["pending", "shipped", "in_transit", "out_for_delivery", "delivered", "failed", "cancelled"]);
export const fulfillmentMethod = pgEnum("fulfillment_method", ["local_driver", "courier", "other_courier", "carrier", "pickup", "none"]);

export const fulfillments = pgTable(
  "fulfillments",
  {
    id: pk(),
    storeId: storeRef(),
    orderId: uuid()
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    /** Per order: #1001-F1, -F2 … */
    name: text().notNull(),
    locationId: uuid().references(() => locations.id, { onDelete: "set null" }),
    status: fulfillmentStatusEnum().notNull().default("shipped"),
    method: fulfillmentMethod().notNull().default("courier"),
    /** Known courier key (delhivery, bluedart, dtdc, …) or a free-text name for other couriers. */
    carrier: text(),
    trackingNumber: text(),
    trackingUrl: text(),
    driverName: text(),
    driverMobile: text(),
    tripLink: text(),
    /** Carrier adapter that created the shipment, with its label. */
    provider: text(),
    providerShipmentId: text(),
    labelUrl: text(),
    notifyCustomer: boolean().notNull().default(true),
    /** Last time staff used "Send delivery details on WhatsApp". */
    whatsappSentAt: timestamp({ withTimezone: true }),
    deliveredAt: timestamp({ withTimezone: true }),
    cancelledAt: timestamp({ withTimezone: true }),
    createdBy: uuid().references(() => staffUsers.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("fulfillments_order_idx").on(t.orderId, t.createdAt),
    index("fulfillments_tracking_idx").on(t.storeId, t.provider, t.trackingNumber),
  ],
);

export const fulfillmentLines = pgTable(
  "fulfillment_lines",
  {
    id: pk(),
    storeId: storeRef(),
    fulfillmentId: uuid()
      .notNull()
      .references(() => fulfillments.id, { onDelete: "cascade" }),
    orderLineId: uuid()
      .notNull()
      .references(() => orderLines.id, { onDelete: "cascade" }),
    quantity: integer().notNull(),
  },
  (t) => [index("fulfillment_lines_fulfillment_idx").on(t.fulfillmentId), index("fulfillment_lines_line_idx").on(t.orderLineId)],
);

/** Carrier tracking webhooks, deduped by provider event id like payment webhooks. */
export const shippingWebhookEvents = pgTable(
  "shipping_webhook_events",
  {
    id: pk(),
    storeId: storeRef(),
    provider: text().notNull(),
    eventId: text().notNull(),
    fulfillmentId: uuid(),
    status: text(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("shipping_webhook_events_uq").on(t.storeId, t.provider, t.eventId)],
);

// ── Returns ──────────────────────────────────────────────────────────────────
export const returnStatus = pgEnum("return_status", ["requested", "approved", "declined", "received", "closed", "cancelled"]);

export const returns = pgTable(
  "returns",
  {
    id: pk(),
    storeId: storeRef(),
    orderId: uuid()
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    /** #1001-R1 … */
    name: text().notNull(),
    status: returnStatus().notNull().default("requested"),
    requestedBy: text().$type<"customer" | "staff">().notNull(),
    customerNote: text(),
    staffNote: text(),
    declineReason: text(),
    resolution: text().$type<"refund" | "exchange" | "none">(),
    refundId: uuid().references(() => refunds.id, { onDelete: "set null" }),
    exchangeDraftId: uuid().references(() => draftOrders.id, { onDelete: "set null" }),
    approvedAt: timestamp({ withTimezone: true }),
    receivedAt: timestamp({ withTimezone: true }),
    closedAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("returns_order_idx").on(t.orderId), index("returns_store_idx").on(t.storeId, t.status, t.createdAt.desc())],
);

export const returnReason = pgEnum("return_reason", ["size", "unwanted", "not_as_described", "wrong_item", "defective", "style", "other"]);

export const returnLines = pgTable(
  "return_lines",
  {
    id: pk(),
    storeId: storeRef(),
    returnId: uuid()
      .notNull()
      .references(() => returns.id, { onDelete: "cascade" }),
    orderLineId: uuid()
      .notNull()
      .references(() => orderLines.id, { onDelete: "cascade" }),
    quantity: integer().notNull(),
    reason: returnReason().notNull().default("other"),
    /** Set at receive time: put back into stock at `locationId`. */
    restock: boolean().notNull().default(true),
    locationId: uuid().references(() => locations.id, { onDelete: "set null" }),
  },
  (t) => [index("return_lines_return_idx").on(t.returnId)],
);

// ── Gift cards ───────────────────────────────────────────────────────────────
/**
 * Codes are shown once at issue and stored as SHA-256 plus the last 4 characters (like API keys).
 * The balance is the sum of the ledger; `balance` is a row-locked cache of it.
 */
export const giftCards = pgTable(
  "gift_cards",
  {
    id: pk(),
    storeId: storeRef(),
    codeHash: text().notNull(),
    lastCharacters: text().notNull(),
    currency: char({ length: 3 }).notNull(),
    initialValue: money().notNull(),
    balance: money().notNull(),
    customerId: uuid().references(() => customers.id, { onDelete: "set null" }),
    /** Bought on this order (gift card product), if any. */
    orderId: uuid().references(() => orders.id, { onDelete: "set null" }),
    orderLineId: uuid(),
    recipientEmail: citext(),
    note: text(),
    expiresAt: timestamp({ withTimezone: true }),
    disabledAt: timestamp({ withTimezone: true }),
    createdBy: uuid().references(() => staffUsers.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("gift_cards_code_uq").on(t.storeId, t.codeHash),
    index("gift_cards_store_idx").on(t.storeId, t.createdAt.desc()),
    uniqueIndex("gift_cards_order_line_uq").on(t.orderLineId, t.lastCharacters),
  ],
);

export const giftCardTxKind = pgEnum("gift_card_tx_kind", ["issue", "redeem", "reverse", "refund", "adjust"]);

export const giftCardTransactions = pgTable(
  "gift_card_transactions",
  {
    id: pk(),
    storeId: storeRef(),
    giftCardId: uuid()
      .notNull()
      .references(() => giftCards.id, { onDelete: "cascade" }),
    kind: giftCardTxKind().notNull(),
    /** Signed: credits positive, redemptions negative. */
    amount: money().notNull(),
    balanceAfter: money().notNull(),
    orderId: uuid().references(() => orders.id, { onDelete: "set null" }),
    note: text(),
    actorType: text().$type<"staff" | "customer" | "system">().notNull(),
    actorId: uuid(),
    createdAt: createdAt(),
  },
  (t) => [index("gift_card_transactions_card_idx").on(t.giftCardId, t.createdAt), index("gift_card_transactions_order_idx").on(t.orderId)],
);

// ── Tax ──────────────────────────────────────────────────────────────────────
/** Generic VAT / sales tax by country and optional region (SPEC §8). */
export const taxRates = pgTable(
  "tax_rates",
  {
    id: pk(),
    storeId: storeRef(),
    country: char({ length: 2 }).notNull(),
    /** Null = the whole country. */
    province: text(),
    name: text().notNull(),
    rateBps: integer().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [unique("tax_rates_region_uq").on(t.storeId, t.country, t.province).nullsNotDistinct()],
);

/** A different rate for products in a collection (e.g. 5% GST on apparel under ₹1000). */
export const taxOverrides = pgTable(
  "tax_overrides",
  {
    id: pk(),
    storeId: storeRef(),
    collectionId: uuid()
      .notNull()
      .references(() => collections.id, { onDelete: "cascade" }),
    /** Null = everywhere. */
    country: char({ length: 2 }),
    province: text(),
    rateBps: integer().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [unique("tax_overrides_uq").on(t.storeId, t.collectionId, t.country, t.province).nullsNotDistinct()],
);

/** Issued invoices: number + a frozen snapshot so reprints never change (GST requires serials). */
export const invoices = pgTable(
  "invoices",
  {
    id: pk(),
    storeId: storeRef(),
    orderId: uuid()
      .notNull()
      .references(() => orders.id, { onDelete: "cascade" }),
    number: text().notNull(),
    data: jsonb().$type<Record<string, unknown>>().notNull(),
    issuedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("invoices_order_uq").on(t.orderId), uniqueIndex("invoices_number_uq").on(t.storeId, t.number)],
);

// ── Analytics ────────────────────────────────────────────────────────────────
/** SPEC §12 built-in daily aggregates (store timezone days). */
export const analyticsDaily = pgTable(
  "analytics_daily",
  {
    storeId: storeRef(),
    day: date({ mode: "string" }).notNull(),
    sessions: integer().notNull().default(0),
    pageViews: integer().notNull().default(0),
    addToCarts: integer().notNull().default(0),
    checkoutsStarted: integer().notNull().default(0),
    orders: integer().notNull().default(0),
    revenue: money().notNull().default(0),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.storeId, t.day] })],
);

// ── Staff invites ────────────────────────────────────────────────────────────
export const staffInvites = pgTable(
  "staff_invites",
  {
    id: pk(),
    storeId: storeRef(),
    email: citext().notNull(),
    name: text(),
    roleId: uuid()
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    tokenHash: text().notNull(),
    invitedBy: uuid().references(() => staffUsers.id, { onDelete: "set null" }),
    expiresAt: timestamp({ withTimezone: true }).notNull(),
    acceptedAt: timestamp({ withTimezone: true }),
    revokedAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("staff_invites_token_uq").on(t.tokenHash), index("staff_invites_store_idx").on(t.storeId, t.createdAt.desc())],
);
