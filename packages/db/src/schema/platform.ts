import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
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
import { bytea, createdAt, pk, updatedAt } from "./columns.js";
import { stores } from "./stores.js";

export const providerKind = pgEnum("provider_kind", ["payment", "storage", "email", "analytics", "shipping"]);
export const providerMode = pgEnum("provider_mode", ["test", "live"]);

/** SPEC §6. Secrets are envelope-encrypted; `config` holds non-secret settings shown in the UI. */
export const providerCredentials = pgTable(
  "provider_credentials",
  {
    id: pk(),
    storeId: uuid()
      .notNull()
      .references(() => stores.id, { onDelete: "cascade" }),
    kind: providerKind().notNull(),
    provider: text().notNull(),
    mode: providerMode().notNull(),
    config: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    ciphertext: bytea().notNull(),
    iv: bytea().notNull(),
    authTag: bytea().notNull(),
    wrappedDek: bytea().notNull(),
    dekIv: bytea().notNull(),
    dekTag: bytea().notNull(),
    keyVersion: integer().notNull(),
    last4: text(),
    enabled: boolean().notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    rotatedAt: timestamp({ withTimezone: true }),
  },
  (t) => [uniqueIndex("provider_credentials_uq").on(t.storeId, t.kind, t.provider, t.mode)],
);

/** Transactional outbox (SPEC §13): written in the same transaction as the data change. */
export const outboxEvents = pgTable(
  "outbox_events",
  {
    id: pk(),
    storeId: uuid()
      .notNull()
      .references(() => stores.id, { onDelete: "cascade" }),
    type: text().notNull(),
    payload: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    availableAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
    dispatchedAt: timestamp({ withTimezone: true }),
    attempts: integer().notNull().default(0),
    lastError: text(),
    createdAt: createdAt(),
  },
  (t) => [
    index("outbox_events_pending_idx").on(t.availableAt).where(sql`${t.dispatchedAt} is null`),
    index("outbox_events_store_idx").on(t.storeId, t.createdAt),
  ],
);

export const media = pgTable(
  "media",
  {
    id: pk(),
    storeId: uuid()
      .notNull()
      .references(() => stores.id, { onDelete: "cascade" }),
    storageProvider: text().notNull(),
    storageKey: text().notNull(),
    filename: text().notNull(),
    contentType: text().notNull(),
    byteSize: bigint({ mode: "number" }).notNull(),
    width: integer(),
    height: integer(),
    alt: text(),
    checksumSha256: text().notNull(),
    visibility: text().$type<"public" | "private">().notNull().default("public"),
    /** pending: direct upload not confirmed yet; ready: original stored; processed by the images queue. */
    status: text().$type<"pending" | "ready" | "failed">().notNull().default("ready"),
    /** Resized WebP/AVIF renditions written by the worker (sharp). */
    renditions: jsonb().$type<MediaRendition[]>().notNull().default([]),
    processedAt: timestamp({ withTimezone: true }),
    processingError: text(),
    /** Original URL for imported images (idempotent CSV re-import). */
    sourceUrl: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("media_store_key_uq").on(t.storeId, t.storageKey), index("media_store_source_idx").on(t.storeId, t.sourceUrl)],
);

export interface MediaRendition {
  width: number;
  height: number;
  format: "webp" | "avif";
  key: string;
  bytes: number;
}

export const jobStatus = pgEnum("job_status", ["queued", "running", "completed", "failed"]);

/**
 * Long-running merchant jobs (CSV import/export, media migration) with progress and an error report
 * (SPEC §8 `jobs_log`). BullMQ holds the queue state; this row is what the admin shows.
 */
export const jobsLog = pgTable(
  "jobs_log",
  {
    id: pk(),
    storeId: uuid()
      .notNull()
      .references(() => stores.id, { onDelete: "cascade" }),
    type: text().$type<"product_import" | "product_export" | "media_migration">().notNull(),
    status: jobStatus().notNull().default("queued"),
    input: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    processed: integer().notNull().default(0),
    total: integer(),
    result: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    errors: jsonb().$type<JobError[]>().notNull().default([]),
    errorCount: integer().notNull().default(0),
    createdBy: uuid(),
    startedAt: timestamp({ withTimezone: true }),
    finishedAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("jobs_log_store_idx").on(t.storeId, t.createdAt.desc())],
);

export interface JobError {
  line?: number;
  ref?: string;
  message: string;
}
