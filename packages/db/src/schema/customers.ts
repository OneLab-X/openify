import { bigint, boolean, char, index, integer, pgEnum, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { citext, createdAt, pk, updatedAt } from "./columns.js";
import { stores } from "./stores.js";

const storeRef = () =>
  uuid()
    .notNull()
    .references(() => stores.id, { onDelete: "cascade" });

export const customerState = pgEnum("customer_state", ["enabled", "disabled"]);

/**
 * SPEC §8 customers. `orders_count`, `total_spent` and `last_order_at` are denormalised from placed
 * orders (kept current by packages/core) so the admin list can sort by lifetime value.
 * Sessions live in Redis like staff sessions; there is no `customer_sessions` table (DECISIONS.md).
 */
export const customers = pgTable(
  "customers",
  {
    id: pk(),
    storeId: storeRef(),
    email: citext().notNull(),
    firstName: text(),
    lastName: text(),
    phone: text(),
    /** argon2id; null for OTP-only accounts. */
    passwordHash: text(),
    state: customerState().notNull().default("enabled"),
    marketingConsent: boolean().notNull().default(false),
    marketingConsentAt: timestamp({ withTimezone: true }),
    note: text(),
    currency: char({ length: 3 }),
    ordersCount: integer().notNull().default(0),
    totalSpent: bigint({ mode: "number" }).notNull().default(0),
    lastOrderAt: timestamp({ withTimezone: true }),
    verifiedAt: timestamp({ withTimezone: true }),
    lastLoginAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("customers_store_email_uq").on(t.storeId, t.email),
    index("customers_store_created_idx").on(t.storeId, t.createdAt.desc(), t.id.desc()),
    index("customers_store_spent_idx").on(t.storeId, t.totalSpent.desc(), t.id.desc()),
  ],
);

export const customerAddresses = pgTable(
  "customer_addresses",
  {
    id: pk(),
    storeId: storeRef(),
    customerId: uuid()
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    firstName: text(),
    lastName: text(),
    company: text(),
    line1: text().notNull(),
    line2: text(),
    city: text().notNull(),
    province: text(),
    postalCode: text(),
    country: char({ length: 2 }).notNull(),
    phone: text(),
    isDefault: boolean().notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("customer_addresses_customer_idx").on(t.customerId)],
);

export const customerTags = pgTable(
  "customer_tags",
  {
    storeId: storeRef(),
    customerId: uuid()
      .notNull()
      .references(() => customers.id, { onDelete: "cascade" }),
    tag: citext().notNull(),
  },
  (t) => [primaryKey({ columns: [t.customerId, t.tag] }), index("customer_tags_store_tag_idx").on(t.storeId, t.tag)],
);
