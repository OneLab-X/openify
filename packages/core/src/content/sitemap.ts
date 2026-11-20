import { and, articles, asc, blogs, collections, eq, pages, products, sql, type Executor } from "@shopkit/db";

/**
 * Sitemap data (SPEC §11): a sitemap index split by type, each type paged at 5,000 URLs (well under
 * Google's 50,000 limit, small enough to render fast). Only live resources are listed.
 */
export const SITEMAP_TYPES = ["products", "collections", "pages", "blogs"] as const;
export type SitemapType = (typeof SITEMAP_TYPES)[number];
export const SITEMAP_PAGE_SIZE = 5_000;

export async function sitemapIndex(db: Executor, storeId: string) {
  const count = async (q: Promise<{ n: number }[]>) => Number((await q)[0]?.n ?? 0);
  const [p, c, pg, a, b] = await Promise.all([
    count(db.select({ n: sql<number>`count(*)::int` }).from(products).where(and(eq(products.storeId, storeId), eq(products.status, "active")))),
    count(db.select({ n: sql<number>`count(*)::int` }).from(collections).where(and(eq(collections.storeId, storeId), eq(collections.published, true)))),
    count(db.select({ n: sql<number>`count(*)::int` }).from(pages).where(and(eq(pages.storeId, storeId), eq(pages.published, true)))),
    count(db.select({ n: sql<number>`count(*)::int` }).from(articles).where(and(eq(articles.storeId, storeId), eq(articles.published, true)))),
    count(db.select({ n: sql<number>`count(*)::int` }).from(blogs).where(eq(blogs.storeId, storeId))),
  ]);
  const pagesOf = (n: number) => Math.ceil(n / SITEMAP_PAGE_SIZE);
  return [
    { type: "pages" as const, pages: Math.max(1, pagesOf(pg + 1)) }, // + home page
    { type: "products" as const, pages: pagesOf(p) },
    { type: "collections" as const, pages: pagesOf(c) },
    { type: "blogs" as const, pages: pagesOf(a + b) },
  ].filter((x) => x.pages > 0);
}

export interface SitemapEntry {
  path: string;
  updatedAt: string;
}

export async function sitemapEntries(db: Executor, storeId: string, type: SitemapType, page: number): Promise<SitemapEntry[]> {
  const offset = (Math.max(1, page) - 1) * SITEMAP_PAGE_SIZE;
  const iso = (d: Date) => d.toISOString();
  switch (type) {
    case "products": {
      const rows = await db.select({ handle: products.handle, updatedAt: products.updatedAt }).from(products).where(and(eq(products.storeId, storeId), eq(products.status, "active"))).orderBy(asc(products.createdAt), asc(products.id)).limit(SITEMAP_PAGE_SIZE).offset(offset);
      return rows.map((r) => ({ path: `/products/${r.handle}`, updatedAt: iso(r.updatedAt) }));
    }
    case "collections": {
      const rows = await db.select({ handle: collections.handle, updatedAt: collections.updatedAt }).from(collections).where(and(eq(collections.storeId, storeId), eq(collections.published, true))).orderBy(asc(collections.createdAt)).limit(SITEMAP_PAGE_SIZE).offset(offset);
      return rows.map((r) => ({ path: `/collections/${r.handle}`, updatedAt: iso(r.updatedAt) }));
    }
    case "pages": {
      const rows = await db.select({ handle: pages.handle, kind: pages.kind, updatedAt: pages.updatedAt }).from(pages).where(and(eq(pages.storeId, storeId), eq(pages.published, true))).orderBy(asc(pages.createdAt)).limit(SITEMAP_PAGE_SIZE).offset(offset);
      const out = rows.map((r) => ({ path: `/${r.kind === "policy" ? "policies" : "pages"}/${r.handle}`, updatedAt: iso(r.updatedAt) }));
      return page <= 1 ? [{ path: "/", updatedAt: iso(new Date()) }, { path: "/collections", updatedAt: iso(new Date()) }, ...out] : out;
    }
    case "blogs": {
      const blogRows = page <= 1 ? await db.select({ handle: blogs.handle, updatedAt: blogs.updatedAt }).from(blogs).where(eq(blogs.storeId, storeId)) : [];
      const rows = await db
        .select({ handle: articles.handle, blog: blogs.handle, updatedAt: articles.updatedAt })
        .from(articles)
        .innerJoin(blogs, eq(blogs.id, articles.blogId))
        .where(and(eq(articles.storeId, storeId), eq(articles.published, true)))
        .orderBy(asc(articles.createdAt))
        .limit(SITEMAP_PAGE_SIZE)
        .offset(offset);
      return [...blogRows.map((b) => ({ path: `/blogs/${b.handle}`, updatedAt: iso(b.updatedAt) })), ...rows.map((r) => ({ path: `/blogs/${r.blog}/${r.handle}`, updatedAt: iso(r.updatedAt) }))];
    }
  }
}
