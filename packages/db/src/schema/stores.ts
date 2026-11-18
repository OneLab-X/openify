import { sql } from "drizzle-orm";
import {
  boolean,
  char,
  index,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { citext, createdAt, pk, updatedAt } from "./columns.js";

export const storeStatus = pgEnum("store_status", ["setup", "active"]);

export interface Address {
  line1?: string;
  line2?: string;
  city?: string;
  province?: string;
  postalCode?: string;
  country?: string;
}

export interface Brand {
  primaryColor?: string;
  accentColor?: string;
}

/** The tenant. Created in `setup` status when the setup token is accepted; `active` after launch. */
export const stores = pgTable("stores", {
  id: pk(),
  status: storeStatus().notNull().default("setup"),
  name: text().notNull().default(""),
  legalName: text(),
  email: citext(),
  phone: text(),
  address: jsonb().$type<Address>().notNull().default({}),
  country: char({ length: 2 }),
  currency: char({ length: 3 }),
  timezone: text(),
  locale: text(),
  weightUnit: text().$type<"kg" | "g" | "lb" | "oz">(),
  logoMediaId: uuid(),
  faviconMediaId: uuid(),
  brand: jsonb().$type<Brand>().notNull().default({}),
  publicUrl: text(),
  launchedAt: timestamp({ withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** Typed key/value settings per store (validated by zod in packages/core). */
export const settings = pgTable(
  "settings",
  {
    storeId: uuid()
      .notNull()
      .references(() => stores.id, { onDelete: "cascade" }),
    key: text().notNull(),
    value: jsonb().notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [primaryKey({ columns: [t.storeId, t.key] })],
);

export const setupState = pgTable("setup_state", {
  storeId: uuid()
    .primaryKey()
    .references(() => stores.id, { onDelete: "cascade" }),
  currentStep: text().notNull().default("owner"),
  completedSteps: text().array().notNull().default(sql`'{}'::text[]`),
  data: jsonb().$type<Record<string, unknown>>().notNull().default({}),
  completedAt: timestamp({ withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const domains = pgTable(
  "domains",
  {
    id: pk(),
    storeId: uuid()
      .notNull()
      .references(() => stores.id, { onDelete: "cascade" }),
    hostname: citext().notNull(),
    isPrimary: boolean().notNull().default(false),
    verifiedAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("domains_hostname_uq").on(t.hostname), index("domains_store_idx").on(t.storeId)],
);

export const locations = pgTable(
  "locations",
  {
    id: pk(),
    storeId: uuid()
      .notNull()
      .references(() => stores.id, { onDelete: "cascade" }),
    name: text().notNull(),
    address: jsonb().$type<Address>().notNull().default({}),
    isDefault: boolean().notNull().default(false),
    active: boolean().notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("locations_store_idx").on(t.storeId)],
);
