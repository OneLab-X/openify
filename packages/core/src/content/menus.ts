import { and, articles, asc, blogs, collections, eq, inArray, menuItems, menus, pages, products, type Executor } from "@shopkit/db";
import { z } from "zod";
import { writeAudit } from "../audit.js";
import { HANDLE_RE, slugify } from "../catalog/handles.js";
import type { Actor, CoreDeps } from "../deps.js";
import { AppError, notFound } from "../errors.js";
import { enqueueEvent } from "../outbox.js";

/**
 * Navigation menus (SPEC §11): nested up to three levels. Items link to a resource by id (so a
 * renamed product keeps working) or to a URL. The storefront gets resolved URLs.
 */
export const MENU_ITEM_KINDS = ["home", "collection", "product", "page", "policy", "blog", "article", "search", "collections", "url"] as const;
export type MenuItemKind = (typeof MENU_ITEM_KINDS)[number];

const linkUrl = z
  .string()
  .trim()
  .max(2000)
  .refine((v) => (v.startsWith("/") && !v.startsWith("//")) || /^(https?:\/\/|mailto:|tel:)/i.test(v), "Use a path like /pages/about or a full link");

export interface MenuItemInput {
  title: string;
  kind: MenuItemKind;
  resourceId?: string | null;
  url?: string | null;
  items?: MenuItemInput[];
}

const itemBase = z.object({
  title: z.string().trim().min(1).max(120),
  kind: z.enum(MENU_ITEM_KINDS),
  resourceId: z.uuid().nullish(),
  url: linkUrl.nullish(),
});
const checks = <T extends z.ZodType<{ kind: MenuItemKind; url?: string | null | undefined; resourceId?: string | null | undefined }>>(schema: T) =>
  schema
    .refine((i) => i.kind !== "url" || !!i.url, { message: "Enter a link", path: ["url"] })
    .refine((i) => ["home", "search", "collections", "url"].includes(i.kind) || !!i.resourceId, { message: "Choose what to link to", path: ["resourceId"] });
// Three explicit levels (no recursive schema): deeper nesting is refused by validation.
const level3 = checks(itemBase.extend({ items: z.array(z.never(), { error: "Menus can be nested three levels deep" }).max(0, "Menus can be nested three levels deep").optional() }));
const level2 = checks(itemBase.extend({ items: z.array(level3).max(50).optional() }));
const itemSchema = checks(itemBase.extend({ items: z.array(level2).max(50).optional() }));

export const menuInput = z.object({
  title: z.string().trim().min(1).max(120),
  handle: z.string().trim().toLowerCase().max(100).regex(HANDLE_RE).optional(),
  items: z.array(itemSchema).max(100),
});

const depth = (items: MenuItemInput[]): number => (items.length ? 1 + Math.max(...items.map((i) => depth(i.items ?? []))) : 0);

type ItemRow = typeof menuItems.$inferSelect;
export interface MenuItemView {
  id: string;
  title: string;
  kind: string;
  resourceId: string | null;
  url: string | null;
  items: MenuItemView[];
}

function tree(rows: ItemRow[], parentId: string | null = null): MenuItemView[] {
  return rows
    .filter((r) => r.parentId === parentId)
    .sort((a, b) => a.position - b.position)
    .map((r) => ({ id: r.id, title: r.title, kind: r.kind, resourceId: r.resourceId, url: r.url, items: tree(rows, r.id) }));
}

export async function listMenus(db: Executor, storeId: string) {
  const rows = await db.select().from(menus).where(eq(menus.storeId, storeId)).orderBy(asc(menus.title));
  const items = rows.length ? await db.select().from(menuItems).where(inArray(menuItems.menuId, rows.map((m) => m.id))) : [];
  return rows.map((m) => ({ id: m.id, title: m.title, handle: m.handle, items: tree(items.filter((i) => i.menuId === m.id)) }));
}

export async function getMenu(db: Executor, storeId: string, id: string) {
  const all = await listMenus(db, storeId);
  const m = all.find((x) => x.id === id);
  if (!m) throw notFound("Menu");
  return m;
}

export async function saveMenu(deps: CoreDeps, actor: Actor, storeId: string, input: z.input<typeof menuInput>, id?: string) {
  const d = menuInput.parse(input);
  if (depth(d.items) > 3) throw new AppError("validation_failed", "Menus can be nested three levels deep");
  const menuId = await deps.db.transaction(async (tx) => {
    const [existing] = id ? await tx.select().from(menus).where(and(eq(menus.storeId, storeId), eq(menus.id, id))).for("update") : [];
    if (id && !existing) throw notFound("Menu");
    const handle = d.handle ?? existing?.handle ?? (slugify(d.title) || "menu");
    const [clash] = await tx.select({ id: menus.id }).from(menus).where(and(eq(menus.storeId, storeId), eq(menus.handle, handle)));
    if (clash && clash.id !== id) throw new AppError("conflict", `A menu with the handle ${handle} already exists`);
    const [row] = existing
      ? await tx.update(menus).set({ title: d.title, handle }).where(eq(menus.id, existing.id)).returning()
      : await tx.insert(menus).values({ storeId, title: d.title, handle }).returning();
    await tx.delete(menuItems).where(eq(menuItems.menuId, row!.id));
    const insert = async (items: MenuItemInput[], parentId: string | null) => {
      for (const [i, it] of items.entries()) {
        const [r] = await tx
          .insert(menuItems)
          .values({ storeId, menuId: row!.id, parentId, title: it.title, kind: it.kind, resourceId: it.resourceId ?? null, url: it.kind === "url" ? (it.url ?? null) : null, position: i })
          .returning({ id: menuItems.id });
        if (it.items?.length) await insert(it.items, r!.id);
      }
    };
    await insert(d.items, null);
    await enqueueEvent(tx, { storeId, type: "content.updated", payload: { kind: "menu", id: row!.id, handle } });
    await writeAudit(tx, actor, { storeId, action: existing ? "menu.updated" : "menu.created", resourceType: "menu", resourceId: row!.id });
    return row!.id;
  });
  return getMenu(deps.db, storeId, menuId);
}

export async function deleteMenu(deps: CoreDeps, actor: Actor, storeId: string, id: string) {
  await deps.db.transaction(async (tx) => {
    const [row] = await tx.delete(menus).where(and(eq(menus.storeId, storeId), eq(menus.id, id))).returning();
    if (!row) throw notFound("Menu");
    await enqueueEvent(tx, { storeId, type: "content.updated", payload: { kind: "menu", id, handle: row.handle } });
    await writeAudit(tx, actor, { storeId, action: "menu.deleted", resourceType: "menu", resourceId: id });
  });
}

export interface ResolvedMenuItem {
  title: string;
  url: string;
  items: ResolvedMenuItem[];
}

/** Storefront: menu by handle with every link resolved to a URL; links to deleted things drop out. */
export async function storefrontMenu(db: Executor, storeId: string, handle: string): Promise<ResolvedMenuItem[]> {
  const [m] = await db.select().from(menus).where(and(eq(menus.storeId, storeId), eq(menus.handle, handle.toLowerCase())));
  if (!m) return [];
  const rows = await db.select().from(menuItems).where(eq(menuItems.menuId, m.id));
  const ids = (kind: string) => rows.filter((r) => r.kind === kind && r.resourceId).map((r) => r.resourceId!);
  const lookup = async <T extends { id: string }>(list: string[], q: (ids: string[]) => Promise<T[]>) => (list.length ? q(list) : []);
  const [cols, prods, pgs, bls, arts] = await Promise.all([
    lookup(ids("collection"), (x) => db.select({ id: collections.id, handle: collections.handle }).from(collections).where(and(eq(collections.storeId, storeId), inArray(collections.id, x), eq(collections.published, true)))),
    lookup(ids("product"), (x) => db.select({ id: products.id, handle: products.handle }).from(products).where(and(eq(products.storeId, storeId), inArray(products.id, x), eq(products.status, "active")))),
    lookup([...ids("page"), ...ids("policy")], (x) => db.select({ id: pages.id, handle: pages.handle, kind: pages.kind }).from(pages).where(and(eq(pages.storeId, storeId), inArray(pages.id, x), eq(pages.published, true)))),
    lookup(ids("blog"), (x) => db.select({ id: blogs.id, handle: blogs.handle }).from(blogs).where(and(eq(blogs.storeId, storeId), inArray(blogs.id, x)))),
    lookup(ids("article"), (x) =>
      db.select({ id: articles.id, handle: articles.handle, blog: blogs.handle }).from(articles).innerJoin(blogs, eq(blogs.id, articles.blogId)).where(and(eq(articles.storeId, storeId), inArray(articles.id, x), eq(articles.published, true))),
    ),
  ]);
  const urlOf = (r: ItemRow): string | null => {
    switch (r.kind) {
      case "home":
        return "/";
      case "search":
        return "/search";
      case "collections":
        return "/collections";
      case "url":
        return r.url;
      case "collection":
        return ((h) => (h ? `/collections/${h}` : null))(cols.find((c) => c.id === r.resourceId)?.handle);
      case "product":
        return ((h) => (h ? `/products/${h}` : null))(prods.find((c) => c.id === r.resourceId)?.handle);
      case "page":
      case "policy": {
        const p = pgs.find((c) => c.id === r.resourceId);
        return p ? `/${p.kind === "policy" ? "policies" : "pages"}/${p.handle}` : null;
      }
      case "blog":
        return ((h) => (h ? `/blogs/${h}` : null))(bls.find((c) => c.id === r.resourceId)?.handle);
      case "article": {
        const a = arts.find((c) => c.id === r.resourceId);
        return a ? `/blogs/${a.blog}/${a.handle}` : null;
      }
      default:
        return null;
    }
  };
  const build = (parentId: string | null): ResolvedMenuItem[] =>
    rows
      .filter((r) => r.parentId === parentId)
      .sort((a, b) => a.position - b.position)
      .flatMap((r) => {
        const url = urlOf(r);
        return url ? [{ title: r.title, url, items: build(r.id) }] : [];
      });
  return build(null);
}

/** Main menu and footer menu created at first boot of the theme (like Shopify's defaults). */
export async function ensureDefaultMenus(deps: CoreDeps, storeId: string) {
  const existing = await deps.db.select({ handle: menus.handle }).from(menus).where(eq(menus.storeId, storeId));
  const have = new Set(existing.map((m) => m.handle));
  const actor: Actor = { type: "system" };
  if (!have.has("main-menu")) await saveMenu(deps, actor, storeId, { title: "Main menu", handle: "main-menu", items: [{ title: "Home", kind: "home" }, { title: "Catalog", kind: "collections" }, { title: "Search", kind: "search" }] });
  if (!have.has("footer")) await saveMenu(deps, actor, storeId, { title: "Footer menu", handle: "footer", items: [{ title: "Search", kind: "search" }] });
}
