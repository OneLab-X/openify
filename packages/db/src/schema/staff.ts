import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { citext, createdAt, pk, updatedAt } from "./columns.js";
import { stores } from "./stores.js";

export const roles = pgTable(
  "roles",
  {
    id: pk(),
    storeId: uuid()
      .notNull()
      .references(() => stores.id, { onDelete: "cascade" }),
    key: text().notNull(),
    name: text().notNull(),
    isSystem: boolean().notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("roles_store_key_uq").on(t.storeId, t.key)],
);

export const rolePermissions = pgTable(
  "role_permissions",
  {
    storeId: uuid()
      .notNull()
      .references(() => stores.id, { onDelete: "cascade" }),
    roleId: uuid()
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    permission: text().notNull(),
  },
  (t) => [primaryKey({ columns: [t.roleId, t.permission] }), index("role_permissions_store_idx").on(t.storeId)],
);

/** Envelope-encrypted value stored as base64 fields (see @shopkit/crypto EncryptedSecret). */
export interface StoredSecret {
  ciphertext: string;
  iv: string;
  authTag: string;
  wrappedDek: string;
  dekIv: string;
  dekTag: string;
  keyVersion: number;
}

export const staffUsers = pgTable(
  "staff_users",
  {
    id: pk(),
    storeId: uuid()
      .notNull()
      .references(() => stores.id, { onDelete: "cascade" }),
    roleId: uuid()
      .notNull()
      .references(() => roles.id),
    name: text().notNull(),
    email: citext().notNull(),
    passwordHash: text().notNull(),
    totpEnabled: boolean().notNull().default(false),
    totpSecret: jsonb().$type<StoredSecret>(),
    totpLastStep: integer(),
    failedLoginCount: integer().notNull().default(0),
    lockedUntil: timestamp({ withTimezone: true }),
    lastLoginAt: timestamp({ withTimezone: true }),
    disabledAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("staff_users_store_email_uq").on(t.storeId, t.email)],
);

export const apiKeys = pgTable(
  "api_keys",
  {
    id: pk(),
    storeId: uuid()
      .notNull()
      .references(() => stores.id, { onDelete: "cascade" }),
    name: text().notNull(),
    prefix: text().notNull(),
    keyHash: text().notNull(),
    scopes: text().array().notNull(),
    createdBy: uuid().references(() => staffUsers.id, { onDelete: "set null" }),
    lastUsedAt: timestamp({ withTimezone: true }),
    expiresAt: timestamp({ withTimezone: true }),
    revokedAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("api_keys_hash_uq").on(t.keyHash), index("api_keys_store_idx").on(t.storeId)],
);

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: pk(),
    storeId: uuid()
      .notNull()
      .references(() => stores.id, { onDelete: "cascade" }),
    actorType: text().$type<"staff" | "setup" | "system" | "api_key">().notNull(),
    actorId: uuid(),
    action: text().notNull(),
    resourceType: text(),
    resourceId: text(),
    ip: text(),
    userAgent: text(),
    metadata: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index("audit_logs_store_created_idx").on(t.storeId, t.createdAt.desc(), t.id.desc())],
);
