import { sql } from "drizzle-orm";
import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid, date } from "drizzle-orm/pg-core";
import { citext, createdAt, pk, updatedAt } from "./columns.js";
import { staffUsers } from "./staff.js";
import { stores } from "./stores.js";

const storeRef = () =>
  uuid()
    .notNull()
    .references(() => stores.id, { onDelete: "cascade" });

// ── Pages, blogs, articles (SPEC §8 content) ─────────────────────────────────
/** Static pages; `kind = 'policy'` pages are the legal pages (privacy, terms, shipping, refund). */
export const pages = pgTable(
  "pages",
  {
    id: pk(),
    storeId: storeRef(),
    title: text().notNull(),
    handle: citext().notNull(),
    bodyHtml: text().notNull().default(""),
    kind: text().$type<"page" | "policy">().notNull().default("page"),
    /** Policy pages: privacy | terms | shipping | refund. */
    policyType: text().$type<"privacy" | "terms" | "shipping" | "refund">(),
    templateSuffix: text(),
    published: boolean().notNull().default(true),
    publishedAt: timestamp({ withTimezone: true }),
    seoTitle: text(),
    seoDescription: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("pages_store_handle_uq").on(t.storeId, t.handle), uniqueIndex("pages_store_policy_uq").on(t.storeId, t.policyType)],
);

export const blogs = pgTable(
  "blogs",
  {
    id: pk(),
    storeId: storeRef(),
    title: text().notNull(),
    handle: citext().notNull(),
    seoTitle: text(),
    seoDescription: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("blogs_store_handle_uq").on(t.storeId, t.handle)],
);

export const articles = pgTable(
  "articles",
  {
    id: pk(),
    storeId: storeRef(),
    blogId: uuid()
      .notNull()
      .references(() => blogs.id, { onDelete: "cascade" }),
    title: text().notNull(),
    handle: citext().notNull(),
    author: text(),
    bodyHtml: text().notNull().default(""),
    excerpt: text(),
    imageMediaId: uuid(),
    tags: text().array().notNull().default(sql`'{}'::text[]`),
    published: boolean().notNull().default(false),
    publishedAt: timestamp({ withTimezone: true }),
    seoTitle: text(),
    seoDescription: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("articles_blog_handle_uq").on(t.blogId, t.handle), index("articles_store_published_idx").on(t.storeId, t.publishedAt.desc())],
);

// ── Navigation ───────────────────────────────────────────────────────────────
export const menus = pgTable(
  "menus",
  {
    id: pk(),
    storeId: storeRef(),
    title: text().notNull(),
    handle: citext().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("menus_store_handle_uq").on(t.storeId, t.handle)],
);

/** A link in a menu; `parentId` nests (the editor allows three levels). */
export const menuItems = pgTable(
  "menu_items",
  {
    id: pk(),
    storeId: storeRef(),
    menuId: uuid()
      .notNull()
      .references(() => menus.id, { onDelete: "cascade" }),
    parentId: uuid(),
    title: text().notNull(),
    /** home | collection | product | page | blog | article | policy | search | url */
    kind: text().notNull().default("url"),
    /** id of the linked resource (kind ≠ url/home/search). */
    resourceId: uuid(),
    url: text(),
    position: integer().notNull().default(0),
  },
  (t) => [index("menu_items_menu_idx").on(t.menuId, t.parentId, t.position)],
);

// ── Redirects ────────────────────────────────────────────────────────────────
export const redirects = pgTable(
  "redirects",
  {
    id: pk(),
    storeId: storeRef(),
    /** Lower-cased path without query, e.g. /products/old-name */
    fromPath: text().notNull(),
    toPath: text().notNull(),
    /** Created automatically when a handle changed. */
    automatic: boolean().notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("redirects_store_from_uq").on(t.storeId, t.fromPath)],
);

// ── Themes (SPEC §8 themes, theme_templates, theme_settings) ──────────────────
export const themes = pgTable(
  "themes",
  {
    id: pk(),
    storeId: storeRef(),
    /** The code package that renders it, e.g. "default". */
    handle: text().notNull(),
    name: text().notNull(),
    /** main = live on the storefront. */
    role: text().$type<"main" | "unpublished">().notNull().default("main"),
    /** Bumped on every publish; the live content is the version with this number. */
    publishedVersion: integer().notNull().default(0),
    draftUpdatedAt: timestamp({ withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("themes_store_handle_uq").on(t.storeId, t.handle)],
);

/** One row per template (index, product, layout…): the draft being edited and the live JSON. */
export const themeTemplates = pgTable(
  "theme_templates",
  {
    id: pk(),
    storeId: storeRef(),
    themeId: uuid()
      .notNull()
      .references(() => themes.id, { onDelete: "cascade" }),
    name: text().notNull(),
    draft: jsonb().$type<Record<string, unknown>>(),
    published: jsonb().$type<Record<string, unknown>>().notNull(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("theme_templates_uq").on(t.themeId, t.name)],
);

/** Global theme settings (colours, fonts, logo…): draft and live. */
export const themeSettings = pgTable("theme_settings", {
  themeId: uuid()
    .primaryKey()
    .references(() => themes.id, { onDelete: "cascade" }),
  storeId: storeRef(),
  draft: jsonb().$type<Record<string, unknown>>(),
  published: jsonb().$type<Record<string, unknown>>().notNull().default({}),
  updatedAt: updatedAt(),
});

/** Snapshot of every template + settings at each publish: history and rollback. */
export const themeVersions = pgTable(
  "theme_versions",
  {
    id: pk(),
    storeId: storeRef(),
    themeId: uuid()
      .notNull()
      .references(() => themes.id, { onDelete: "cascade" }),
    version: integer().notNull(),
    settings: jsonb().$type<Record<string, unknown>>().notNull(),
    templates: jsonb().$type<Record<string, Record<string, unknown>>>().notNull(),
    note: text(),
    publishedBy: uuid().references(() => staffUsers.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("theme_versions_uq").on(t.themeId, t.version)],
);

// ── First-party analytics events (SPEC §12) ──────────────────────────────────
/**
 * Raw storefront events (page_view, view_item, add_to_cart, begin_checkout, purchase). No cookies,
 * no IP: a per-tab random session id. The worker rolls them into `analytics_daily` and prunes old rows.
 */
export const analyticsEvents = pgTable(
  "analytics_events",
  {
    id: pk(),
    storeId: storeRef(),
    sessionId: text().notNull(),
    name: text().notNull(),
    path: text(),
    day: date({ mode: "string" }).notNull(),
    data: jsonb().$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index("analytics_events_store_day_idx").on(t.storeId, t.day, t.name)],
);
