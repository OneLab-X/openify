import { and, articles, asc, blogs, desc, eq, inArray, media, ne, pages, sql, type Executor } from "@shopkit/db";
import { z } from "zod";
import { writeAudit } from "../audit.js";
import { HANDLE_RE, slugify } from "../catalog/handles.js";
import { htmlToText, sanitizeHtml } from "../catalog/html.js";
import { mediaView } from "../catalog/media-view.js";
import type { Actor, CoreDeps } from "../deps.js";
import { now } from "../deps.js";
import { AppError, notFound } from "../errors.js";
import { enqueueEvent } from "../outbox.js";
import { getStore } from "../stores.js";
import { recordHandleChange } from "./redirects.js";

/**
 * CMS (SPEC §11): pages, policy pages, blogs and articles. HTML from the TipTap editor is
 * sanitised on write and again on output. Changing a handle adds a redirect from the old URL.
 */
const handle = z.string().trim().toLowerCase().max(200).regex(HANDLE_RE, "Lowercase letters, numbers and dashes").optional();
const seo = { seoTitle: z.string().trim().max(120).nullish(), seoDescription: z.string().trim().max(320).nullish() };

async function uniqueIn(db: Executor, table: typeof pages | typeof blogs, storeId: string, base: string, excludeId?: string) {
  const root = base || "page";
  const rows = await db
    .select({ handle: table.handle })
    .from(table)
    .where(and(eq(table.storeId, storeId), sql`(${table.handle} = ${root} or ${table.handle} like ${`${root.replace(/[\\%_]/g, "\\$&")}-%`})`, excludeId ? ne(table.id, excludeId) : undefined));
  const taken = new Set(rows.map((r) => r.handle.toLowerCase()));
  if (!taken.has(root)) return root;
  for (let i = 2; ; i++) if (!taken.has(`${root}-${i}`)) return `${root}-${i}`;
}

// ── Pages ────────────────────────────────────────────────────────────────────
export const pageInput = z.object({
  title: z.string().trim().min(1).max(200),
  handle,
  bodyHtml: z.string().max(500_000).default(""),
  published: z.boolean().default(true),
  ...seo,
});

type PageRow = typeof pages.$inferSelect;
export const pageView = (p: PageRow) => ({
  id: p.id,
  title: p.title,
  handle: p.handle,
  bodyHtml: p.bodyHtml,
  kind: p.kind,
  policyType: p.policyType,
  published: p.published,
  publishedAt: p.publishedAt?.toISOString() ?? null,
  seoTitle: p.seoTitle,
  seoDescription: p.seoDescription,
  url: p.kind === "policy" ? `/policies/${p.handle}` : `/pages/${p.handle}`,
  updatedAt: p.updatedAt.toISOString(),
});

export async function listPages(db: Executor, storeId: string, kind?: "page" | "policy") {
  const rows = await db.select().from(pages).where(and(eq(pages.storeId, storeId), kind ? eq(pages.kind, kind) : undefined)).orderBy(asc(pages.kind), asc(pages.title));
  return rows.map(pageView);
}

export async function getPage(db: Executor, storeId: string, id: string) {
  const [p] = await db.select().from(pages).where(and(eq(pages.storeId, storeId), eq(pages.id, id)));
  if (!p) throw notFound("Page");
  return pageView(p);
}

export async function savePage(deps: CoreDeps, actor: Actor, storeId: string, input: z.input<typeof pageInput>, id?: string) {
  const d = pageInput.parse(input);
  const body = await sanitizeHtml(d.bodyHtml);
  return deps.db.transaction(async (tx) => {
    const [existing] = id ? await tx.select().from(pages).where(and(eq(pages.storeId, storeId), eq(pages.id, id))).for("update") : [];
    if (id && !existing) throw notFound("Page");
    const h = await uniqueIn(tx, pages, storeId, d.handle ?? (existing?.handle || slugify(d.title)), id);
    const values = {
      title: d.title,
      handle: h,
      bodyHtml: body,
      published: d.published,
      publishedAt: d.published ? (existing?.publishedAt ?? now(deps)) : null,
      seoTitle: d.seoTitle ?? null,
      seoDescription: d.seoDescription ?? null,
    };
    const [row] = existing ? await tx.update(pages).set(values).where(eq(pages.id, existing.id)).returning() : await tx.insert(pages).values({ storeId, ...values }).returning();
    const prefix = row!.kind === "policy" ? "/policies/" : "/pages/";
    if (existing && existing.handle !== h) await recordHandleChange(tx, storeId, `${prefix}${existing.handle}`, `${prefix}${h}`);
    await enqueueEvent(tx, { storeId, type: "content.updated", payload: { kind: "page", id: row!.id, handle: h, previousHandle: existing && existing.handle !== h ? existing.handle : null } });
    await writeAudit(tx, actor, { storeId, action: existing ? "page.updated" : "page.created", resourceType: "page", resourceId: row!.id });
    return pageView(row!);
  });
}

export async function deletePage(deps: CoreDeps, actor: Actor, storeId: string, id: string) {
  await deps.db.transaction(async (tx) => {
    const [row] = await tx.delete(pages).where(and(eq(pages.storeId, storeId), eq(pages.id, id))).returning();
    if (!row) throw notFound("Page");
    await enqueueEvent(tx, { storeId, type: "content.updated", payload: { kind: "page", id, handle: row.handle } });
    await writeAudit(tx, actor, { storeId, action: "page.deleted", resourceType: "page", resourceId: id });
  });
}

/** Published page or policy by handle (storefront). Body sanitised again on output. */
export async function storefrontPage(db: Executor, storeId: string, handleIn: string, kind: "page" | "policy") {
  const [p] = await db.select().from(pages).where(and(eq(pages.storeId, storeId), eq(pages.handle, handleIn.toLowerCase()), eq(pages.kind, kind), eq(pages.published, true)));
  if (!p) return null;
  return { ...pageView(p), bodyHtml: await sanitizeHtml(p.bodyHtml), description: p.seoDescription || htmlToText(p.bodyHtml).slice(0, 300) };
}

// ── Policy pages with generator templates ───────────────────────────────────
export const POLICY_TYPES = ["privacy", "terms", "shipping", "refund"] as const;
export type PolicyType = (typeof POLICY_TYPES)[number];
const POLICY_META: Record<PolicyType, { title: string; handle: string }> = {
  privacy: { title: "Privacy policy", handle: "privacy-policy" },
  terms: { title: "Terms of service", handle: "terms-of-service" },
  shipping: { title: "Shipping policy", handle: "shipping-policy" },
  refund: { title: "Refund policy", handle: "refund-policy" },
};

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Starting text for a policy, filled with the store's details. A template, not legal advice: the
 * editor says so and the merchant edits it before publishing.
 */
export function policyTemplate(type: PolicyType, store: { name: string; email: string | null; country: string | null; address: string }): string {
  const name = esc(store.name || "our store");
  const contact = store.email ? `<a href="mailto:${esc(store.email)}">${esc(store.email)}</a>` : "the contact details on this site";
  const where = store.address ? `<p>${esc(store.address)}</p>` : "";
  switch (type) {
    case "privacy":
      return `<h2>Who we are</h2><p>${name} runs this online store. This policy explains what personal information we collect when you visit or buy, and how we use it.</p>${where}
<h2>What we collect</h2><ul><li>Order details: your name, email, phone number, shipping and billing addresses and what you bought.</li><li>Payment details are handled by our payment providers; we never see or store your full card number.</li><li>Basic usage data (pages viewed) to understand how the store is used. Third-party analytics run only if you accept them in the cookie banner.</li></ul>
<h2>How we use it</h2><p>To fulfil and deliver orders, send order updates, answer questions, prevent fraud and, if you opt in, send marketing emails you can unsubscribe from at any time.</p>
<h2>Sharing</h2><p>We share information only with the services that run the store (payments, shipping, email, hosting) and when the law requires it. We do not sell personal information.</p>
<h2>Your rights</h2><p>You can ask to see, correct or delete your personal information by writing to ${contact}.</p>`;
    case "terms":
      return `<h2>Overview</h2><p>This website is operated by ${name}. By visiting or buying from it you agree to these terms.</p>
<h2>Products and prices</h2><p>We try to describe products and prices accurately. If we find an error after you order, we will contact you before shipping and refund you if you prefer.</p>
<h2>Orders</h2><p>We may refuse or cancel an order, for example if an item is out of stock or a payment cannot be verified; any payment taken is refunded in full.</p>
<h2>Liability</h2><p>To the extent the law allows, our liability is limited to the amount you paid for the order.</p>
<h2>Contact</h2><p>Questions about these terms: ${contact}.</p>`;
    case "shipping":
      return `<h2>Processing</h2><p>Orders are packed within 1–2 business days. You will receive an email with tracking details once your order ships.</p>
<h2>Delivery times and costs</h2><p>Shipping options and prices are shown at checkout before you pay. Delivery usually takes 3–7 business days depending on your location.</p>
<h2>Problems with delivery</h2><p>If your package is late, damaged or lost, write to ${contact} with your order number and we will sort it out.</p>`;
    case "refund":
      return `<h2>Returns</h2><p>You can request a return within 7 days of delivery from your order status page or account. Items must be unused, with tags and in the original packaging.</p>
<h2>Refunds</h2><p>Once we receive and check the items we refund the original payment method within 5–7 business days. Shipping charges are refunded only if the item was damaged or wrong.</p>
<h2>Exchanges</h2><p>For a different size or colour, request a return and choose exchange; we will send the replacement once the original arrives.</p>
<h2>Contact</h2><p>${contact}</p>`;
  }
}

export async function generatePolicy(deps: CoreDeps, actor: Actor, storeId: string, type: PolicyType, opts: { overwrite?: boolean } = {}) {
  const store = await getStore(deps.db, storeId);
  const a = store.address ?? {};
  const address = [a.line1, a.line2, a.city, a.province, a.postalCode, a.country].filter(Boolean).join(", ");
  const html = policyTemplate(type, { name: store.name, email: store.email, country: store.country, address });
  return deps.db.transaction(async (tx) => {
    const [existing] = await tx.select().from(pages).where(and(eq(pages.storeId, storeId), eq(pages.policyType, type)));
    if (existing && !opts.overwrite) throw new AppError("conflict", "This policy already exists; pass overwrite to replace its text");
    const meta = POLICY_META[type];
    const [row] = existing
      ? await tx.update(pages).set({ bodyHtml: html }).where(eq(pages.id, existing.id)).returning()
      : await tx.insert(pages).values({ storeId, kind: "policy", policyType: type, title: meta.title, handle: await uniqueIn(tx, pages, storeId, meta.handle), bodyHtml: html, published: true, publishedAt: now(deps) }).returning();
    await enqueueEvent(tx, { storeId, type: "content.updated", payload: { kind: "page", id: row!.id, handle: row!.handle } });
    await writeAudit(tx, actor, { storeId, action: "policy.generated", resourceType: "page", resourceId: row!.id, metadata: { type } });
    return pageView(row!);
  });
}

/** Published policies for the footer, in a fixed order. */
export async function storefrontPolicies(db: Executor, storeId: string) {
  const rows = await db.select({ title: pages.title, handle: pages.handle, policyType: pages.policyType }).from(pages).where(and(eq(pages.storeId, storeId), eq(pages.kind, "policy"), eq(pages.published, true)));
  return rows.sort((a, b) => POLICY_TYPES.indexOf(a.policyType!) - POLICY_TYPES.indexOf(b.policyType!)).map((r) => ({ title: r.title, url: `/policies/${r.handle}` }));
}

// ── Blogs and articles ──────────────────────────────────────────────────────
export const blogInput = z.object({ title: z.string().trim().min(1).max(200), handle, ...seo });

const blogView = (b: typeof blogs.$inferSelect, count = 0) => ({
  id: b.id,
  title: b.title,
  handle: b.handle,
  seoTitle: b.seoTitle,
  seoDescription: b.seoDescription,
  articlesCount: count,
  url: `/blogs/${b.handle}`,
  updatedAt: b.updatedAt.toISOString(),
});

export async function listBlogs(db: Executor, storeId: string) {
  const rows = await db.select().from(blogs).where(eq(blogs.storeId, storeId)).orderBy(asc(blogs.title));
  const counts = rows.length ? await db.select({ blogId: articles.blogId, n: sql<number>`count(*)::int` }).from(articles).where(inArray(articles.blogId, rows.map((r) => r.id))).groupBy(articles.blogId) : [];
  return rows.map((b) => blogView(b, counts.find((c) => c.blogId === b.id)?.n ?? 0));
}

export async function saveBlog(deps: CoreDeps, actor: Actor, storeId: string, input: z.input<typeof blogInput>, id?: string) {
  const d = blogInput.parse(input);
  return deps.db.transaction(async (tx) => {
    const [existing] = id ? await tx.select().from(blogs).where(and(eq(blogs.storeId, storeId), eq(blogs.id, id))).for("update") : [];
    if (id && !existing) throw notFound("Blog");
    const h = await uniqueIn(tx, blogs, storeId, d.handle ?? (existing?.handle || slugify(d.title)), id);
    const values = { title: d.title, handle: h, seoTitle: d.seoTitle ?? null, seoDescription: d.seoDescription ?? null };
    const [row] = existing ? await tx.update(blogs).set(values).where(eq(blogs.id, existing.id)).returning() : await tx.insert(blogs).values({ storeId, ...values }).returning();
    if (existing && existing.handle !== h) {
      await recordHandleChange(tx, storeId, `/blogs/${existing.handle}`, `/blogs/${h}`);
      const posts = await tx.select({ handle: articles.handle }).from(articles).where(eq(articles.blogId, existing.id));
      for (const p of posts) await recordHandleChange(tx, storeId, `/blogs/${existing.handle}/${p.handle}`, `/blogs/${h}/${p.handle}`);
    }
    await enqueueEvent(tx, { storeId, type: "content.updated", payload: { kind: "blog", id: row!.id, handle: h } });
    await writeAudit(tx, actor, { storeId, action: existing ? "blog.updated" : "blog.created", resourceType: "blog", resourceId: row!.id });
    return blogView(row!);
  });
}

export async function deleteBlog(deps: CoreDeps, actor: Actor, storeId: string, id: string) {
  await deps.db.transaction(async (tx) => {
    const [row] = await tx.delete(blogs).where(and(eq(blogs.storeId, storeId), eq(blogs.id, id))).returning();
    if (!row) throw notFound("Blog");
    await enqueueEvent(tx, { storeId, type: "content.updated", payload: { kind: "blog", id, handle: row.handle } });
    await writeAudit(tx, actor, { storeId, action: "blog.deleted", resourceType: "blog", resourceId: id });
  });
}

export const articleInput = z.object({
  blogId: z.uuid(),
  title: z.string().trim().min(1).max(250),
  handle,
  author: z.string().trim().max(120).nullish(),
  bodyHtml: z.string().max(1_000_000).default(""),
  excerpt: z.string().trim().max(1000).nullish(),
  imageMediaId: z.uuid().nullish(),
  tags: z.array(z.string().trim().min(1).max(60)).max(40).default([]),
  published: z.boolean().default(false),
  publishedAt: z.coerce.date().nullish(),
  ...seo,
});

type ArticleRow = typeof articles.$inferSelect;
async function articleViews(deps: Pick<CoreDeps, "db" | "runtime">, rows: ArticleRow[]) {
  const db = deps.db;
  const ids = [...new Set(rows.map((r) => r.imageMediaId).filter((x): x is string => !!x))];
  const blogRows = rows.length ? await db.select({ id: blogs.id, handle: blogs.handle, title: blogs.title }).from(blogs).where(inArray(blogs.id, [...new Set(rows.map((r) => r.blogId))])) : [];
  const images = ids.length ? await db.select().from(media).where(inArray(media.id, ids)) : [];
  return rows.map((a) => {
    const blog = blogRows.find((b) => b.id === a.blogId);
    const image = images.find((m) => m.id === a.imageMediaId);
    return {
      id: a.id,
      blogId: a.blogId,
      blogHandle: blog?.handle ?? "",
      blogTitle: blog?.title ?? "",
      title: a.title,
      handle: a.handle,
      author: a.author,
      bodyHtml: a.bodyHtml,
      excerpt: a.excerpt,
      image: image ? mediaView(deps, image) : null,
      tags: a.tags,
      published: a.published,
      publishedAt: a.publishedAt?.toISOString() ?? null,
      seoTitle: a.seoTitle,
      seoDescription: a.seoDescription,
      url: `/blogs/${blog?.handle ?? ""}/${a.handle}`,
      createdAt: a.createdAt.toISOString(),
      updatedAt: a.updatedAt.toISOString(),
    };
  });
}
export type ArticleView = Awaited<ReturnType<typeof articleViews>>[number];

export async function listArticles(deps: Pick<CoreDeps, "db" | "runtime">, storeId: string, q: { blogId?: string; limit?: number } = {}) {
  const db = deps.db;
  const rows = await db
    .select()
    .from(articles)
    .where(and(eq(articles.storeId, storeId), q.blogId ? eq(articles.blogId, q.blogId) : undefined))
    .orderBy(desc(articles.createdAt))
    .limit(Math.min(q.limit ?? 100, 250));
  return articleViews(deps, rows);
}

export async function getArticle(deps: Pick<CoreDeps, "db" | "runtime">, storeId: string, id: string) {
  const db = deps.db;
  const [a] = await db.select().from(articles).where(and(eq(articles.storeId, storeId), eq(articles.id, id)));
  if (!a) throw notFound("Article");
  return (await articleViews(deps, [a]))[0]!;
}

export async function saveArticle(deps: CoreDeps, actor: Actor, storeId: string, input: z.input<typeof articleInput>, id?: string) {
  const d = articleInput.parse(input);
  const body = await sanitizeHtml(d.bodyHtml);
  const row = await deps.db.transaction(async (tx) => {
    const [blog] = await tx.select().from(blogs).where(and(eq(blogs.storeId, storeId), eq(blogs.id, d.blogId)));
    if (!blog) throw notFound("Blog");
    const [existing] = id ? await tx.select().from(articles).where(and(eq(articles.storeId, storeId), eq(articles.id, id))).for("update") : [];
    if (id && !existing) throw notFound("Article");
    const base = d.handle ?? (existing?.handle || slugify(d.title) || "post");
    const taken = await tx.select({ handle: articles.handle }).from(articles).where(and(eq(articles.blogId, blog.id), id ? ne(articles.id, id) : undefined));
    const used = new Set(taken.map((t) => t.handle.toLowerCase()));
    let h = base;
    for (let i = 2; used.has(h); i++) h = `${base}-${i}`;
    const values = {
      blogId: blog.id,
      title: d.title,
      handle: h,
      author: d.author ?? null,
      bodyHtml: body,
      excerpt: d.excerpt ?? null,
      imageMediaId: d.imageMediaId ?? null,
      tags: [...new Set(d.tags)],
      published: d.published,
      publishedAt: d.published ? (d.publishedAt ?? existing?.publishedAt ?? now(deps)) : null,
      seoTitle: d.seoTitle ?? null,
      seoDescription: d.seoDescription ?? null,
    };
    const [r] = existing ? await tx.update(articles).set(values).where(eq(articles.id, existing.id)).returning() : await tx.insert(articles).values({ storeId, ...values }).returning();
    if (existing) {
      const [oldBlog] = await tx.select({ handle: blogs.handle }).from(blogs).where(eq(blogs.id, existing.blogId));
      const oldUrl = `/blogs/${oldBlog?.handle ?? blog.handle}/${existing.handle}`;
      const newUrl = `/blogs/${blog.handle}/${h}`;
      if (oldUrl !== newUrl) await recordHandleChange(tx, storeId, oldUrl, newUrl);
    }
    await enqueueEvent(tx, { storeId, type: "content.updated", payload: { kind: "article", id: r!.id, handle: h, blogHandle: blog.handle } });
    await writeAudit(tx, actor, { storeId, action: existing ? "article.updated" : "article.created", resourceType: "article", resourceId: r!.id });
    return r!;
  });
  return (await articleViews(deps, [row]))[0]!;
}

export async function deleteArticle(deps: CoreDeps, actor: Actor, storeId: string, id: string) {
  await deps.db.transaction(async (tx) => {
    const [row] = await tx.delete(articles).where(and(eq(articles.storeId, storeId), eq(articles.id, id))).returning();
    if (!row) throw notFound("Article");
    await enqueueEvent(tx, { storeId, type: "content.updated", payload: { kind: "article", id } });
    await writeAudit(tx, actor, { storeId, action: "article.deleted", resourceType: "article", resourceId: id });
  });
}

/** Storefront: a blog with its published posts (newest first, paged). */
export async function storefrontBlog(deps: Pick<CoreDeps, "db" | "runtime">, storeId: string, blogHandle: string, q: { page?: number; perPage?: number; tag?: string } = {}) {
  const db = deps.db;
  const [blog] = await db.select().from(blogs).where(and(eq(blogs.storeId, storeId), eq(blogs.handle, blogHandle.toLowerCase())));
  if (!blog) return null;
  const per = Math.min(q.perPage ?? 12, 50);
  const page = Math.max(1, q.page ?? 1);
  const where = and(eq(articles.blogId, blog.id), eq(articles.published, true), q.tag ? sql`${q.tag} = any(${articles.tags})` : undefined);
  const [rows, [count]] = await Promise.all([
    db.select().from(articles).where(where).orderBy(desc(articles.publishedAt)).limit(per).offset((page - 1) * per),
    db.select({ n: sql<number>`count(*)::int` }).from(articles).where(where),
  ]);
  const items = (await articleViews(deps, rows)).map((a) => ({ ...a, bodyHtml: "", excerpt: a.excerpt || htmlToText(rows.find((r) => r.id === a.id)!.bodyHtml).slice(0, 220) }));
  return { blog: blogView(blog, count?.n ?? 0), items, page, pages: Math.max(1, Math.ceil((count?.n ?? 0) / per)) };
}

export async function storefrontArticle(deps: Pick<CoreDeps, "db" | "runtime">, storeId: string, blogHandle: string, articleHandle: string) {
  const [row] = await deps.db
    .select({ a: articles })
    .from(articles)
    .innerJoin(blogs, eq(blogs.id, articles.blogId))
    .where(and(eq(articles.storeId, storeId), eq(blogs.handle, blogHandle.toLowerCase()), eq(articles.handle, articleHandle.toLowerCase()), eq(articles.published, true)));
  if (!row) return null;
  const [v] = await articleViews(deps, [row.a]);
  return { ...v!, bodyHtml: await sanitizeHtml(v!.bodyHtml), description: v!.seoDescription || v!.excerpt || htmlToText(v!.bodyHtml).slice(0, 300) };
}
