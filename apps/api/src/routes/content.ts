import {
  AppError,
  analyticsConfig,
  articleInput,
  blogInput,
  createPreviewToken,
  deleteArticle,
  deleteBlog,
  deleteMenu,
  deletePage,
  deleteRedirect,
  discardThemeDraft,
  ensureTheme,
  eventsInput,
  findRedirect,
  generatePolicy,
  getArticle,
  getInstallStore,
  getMenu,
  getPage,
  listArticles,
  listBlogs,
  listMenus,
  listPages,
  listRedirects,
  menuInput,
  newsletterInput,
  pageInput,
  POLICY_TYPES,
  publishTheme,
  recordEvents,
  redirectInput,
  rollbackTheme,
  saveArticle,
  saveBlog,
  saveMenu,
  savePage,
  saveRedirect,
  saveThemeDraft,
  SITEMAP_TYPES,
  sitemapEntries,
  sitemapIndex,
  storefrontArticle,
  storefrontBlog,
  storefrontMenu,
  storefrontPage,
  storefrontPolicies,
  storefrontTheme,
  subscribeNewsletter,
  themeDraftInput,
  themeEditorState,
  verifyPreviewToken,
} from "@shopkit/core";
import type { FastifyReply } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { AppDeps } from "../deps.js";
import { actorOf, requireStaff } from "../plugins/auth.js";
import { errorResponses, okBody } from "../schemas.js";
import {
  analyticsConfigSchema,
  articleSchema,
  blogSchema,
  menuSchema,
  pageSchema,
  redirectSchema,
  sitemapIndexSchema,
  sitemapPageSchema,
  storefrontArticleSchema,
  storefrontBlogSchema,
  storefrontMenuSchema,
  storefrontPageSchema,
  storefrontThemeSchema,
  templateName,
  themeDraftResultSchema,
  themeEditorSchema,
} from "../schemas-content.js";

const ok = { ok: true as const };
const idParams = z.object({ id: z.uuid() });

/** Admin: theme editor, pages and policies, blogs and articles, menus, redirects. */
export const contentAdminRoutes: FastifyPluginAsyncZod<{ deps: AppDeps }> = async (app, { deps }) => {
  const tags = ["admin"];
  const sid = (req: { staff?: { storeId: string } }) => req.staff!.storeId;
  const write = requireStaff(deps, "content:write");

  // ── Theme editor ───────────────────────────────────────────────────────────
  app.get("/theme", { onRequest: write, schema: { tags, operationId: "getThemeEditor", response: { 200: themeEditorSchema, ...errorResponses } } }, (req) => themeEditorState(deps, sid(req)));
  app.put("/theme/draft", { onRequest: write, bodyLimit: 2 * 1024 * 1024, schema: { tags, operationId: "saveThemeDraft", body: themeDraftInput, response: { 200: themeDraftResultSchema, ...errorResponses } } }, (req) =>
    saveThemeDraft(deps, actorOf(req), sid(req), req.body),
  );
  app.delete("/theme/draft", { onRequest: write, schema: { tags, operationId: "discardThemeDraft", response: { 200: okBody, ...errorResponses } } }, async (req) => {
    await discardThemeDraft(deps, actorOf(req), sid(req));
    return ok;
  });
  app.post(
    "/theme/publish",
    { onRequest: write, schema: { tags, operationId: "publishTheme", body: z.object({ note: z.string().max(200).nullish() }), response: { 200: z.object({ version: z.number().int() }), ...errorResponses } } },
    (req) => publishTheme(deps, actorOf(req), sid(req), req.body),
  );
  app.post(
    "/theme/rollback",
    { onRequest: write, schema: { tags, operationId: "rollbackTheme", body: z.object({ version: z.number().int().min(1) }), response: { 200: z.object({ version: z.number().int() }), ...errorResponses } } },
    (req) => rollbackTheme(deps, actorOf(req), sid(req), req.body.version),
  );
  app.post("/theme/preview-token", { onRequest: write, schema: { tags, operationId: "themePreviewToken", response: { 200: z.object({ token: z.string() }), ...errorResponses } } }, (req) => ({
    token: createPreviewToken(deps, sid(req)),
  }));

  // ── Pages & policies ───────────────────────────────────────────────────────
  app.get("/pages", { onRequest: write, schema: { tags, operationId: "listPages", querystring: z.object({ kind: z.enum(["page", "policy"]).optional() }), response: { 200: z.object({ items: z.array(pageSchema) }), ...errorResponses } } }, async (req) => ({
    items: await listPages(deps.db, sid(req), req.query.kind),
  }));
  app.post("/pages", { onRequest: write, schema: { tags, operationId: "createPage", body: pageInput, response: { 200: pageSchema, ...errorResponses } } }, (req) => savePage(deps, actorOf(req), sid(req), req.body));
  app.get("/pages/:id", { onRequest: write, schema: { tags, operationId: "getPage", params: idParams, response: { 200: pageSchema, ...errorResponses } } }, (req) => getPage(deps.db, sid(req), req.params.id));
  app.put("/pages/:id", { onRequest: write, schema: { tags, operationId: "updatePage", params: idParams, body: pageInput, response: { 200: pageSchema, ...errorResponses } } }, (req) =>
    savePage(deps, actorOf(req), sid(req), req.body, req.params.id),
  );
  app.delete("/pages/:id", { onRequest: write, schema: { tags, operationId: "deletePage", params: idParams, response: { 200: okBody, ...errorResponses } } }, async (req) => {
    await deletePage(deps, actorOf(req), sid(req), req.params.id);
    return ok;
  });
  app.post(
    "/policies/:type/generate",
    {
      onRequest: write,
      schema: { tags, operationId: "generatePolicy", params: z.object({ type: z.enum(POLICY_TYPES) }), body: z.object({ overwrite: z.boolean().default(false) }), response: { 200: pageSchema, ...errorResponses } },
    },
    (req) => generatePolicy(deps, actorOf(req), sid(req), req.params.type, req.body),
  );

  // ── Blogs & articles ───────────────────────────────────────────────────────
  app.get("/blogs", { onRequest: write, schema: { tags, operationId: "listBlogs", response: { 200: z.object({ items: z.array(blogSchema) }), ...errorResponses } } }, async (req) => ({ items: await listBlogs(deps.db, sid(req)) }));
  app.post("/blogs", { onRequest: write, schema: { tags, operationId: "createBlog", body: blogInput, response: { 200: blogSchema, ...errorResponses } } }, (req) => saveBlog(deps, actorOf(req), sid(req), req.body));
  app.put("/blogs/:id", { onRequest: write, schema: { tags, operationId: "updateBlog", params: idParams, body: blogInput, response: { 200: blogSchema, ...errorResponses } } }, (req) =>
    saveBlog(deps, actorOf(req), sid(req), req.body, req.params.id),
  );
  app.delete("/blogs/:id", { onRequest: write, schema: { tags, operationId: "deleteBlog", params: idParams, response: { 200: okBody, ...errorResponses } } }, async (req) => {
    await deleteBlog(deps, actorOf(req), sid(req), req.params.id);
    return ok;
  });
  app.get(
    "/articles",
    { onRequest: write, schema: { tags, operationId: "listArticles", querystring: z.object({ blogId: z.uuid().optional() }), response: { 200: z.object({ items: z.array(articleSchema) }), ...errorResponses } } },
    async (req) => ({ items: await listArticles(deps, sid(req), req.query.blogId ? { blogId: req.query.blogId } : {}) }),
  );
  app.post("/articles", { onRequest: write, schema: { tags, operationId: "createArticle", body: articleInput, response: { 200: articleSchema, ...errorResponses } } }, (req) => saveArticle(deps, actorOf(req), sid(req), req.body));
  app.get("/articles/:id", { onRequest: write, schema: { tags, operationId: "getArticle", params: idParams, response: { 200: articleSchema, ...errorResponses } } }, (req) => getArticle(deps, sid(req), req.params.id));
  app.put("/articles/:id", { onRequest: write, schema: { tags, operationId: "updateArticle", params: idParams, body: articleInput, response: { 200: articleSchema, ...errorResponses } } }, (req) =>
    saveArticle(deps, actorOf(req), sid(req), req.body, req.params.id),
  );
  app.delete("/articles/:id", { onRequest: write, schema: { tags, operationId: "deleteArticle", params: idParams, response: { 200: okBody, ...errorResponses } } }, async (req) => {
    await deleteArticle(deps, actorOf(req), sid(req), req.params.id);
    return ok;
  });

  // ── Menus ──────────────────────────────────────────────────────────────────
  app.get("/menus", { onRequest: write, schema: { tags, operationId: "listMenus", response: { 200: z.object({ items: z.array(menuSchema) }), ...errorResponses } } }, async (req) => {
    await ensureTheme(deps, sid(req)); // creates the default main and footer menus on first use
    return { items: await listMenus(deps.db, sid(req)) };
  });
  app.post("/menus", { onRequest: write, schema: { tags, operationId: "createMenu", body: menuInput, response: { 200: menuSchema, ...errorResponses } } }, (req) => saveMenu(deps, actorOf(req), sid(req), req.body));
  app.get("/menus/:id", { onRequest: write, schema: { tags, operationId: "getMenu", params: idParams, response: { 200: menuSchema, ...errorResponses } } }, (req) => getMenu(deps.db, sid(req), req.params.id));
  app.put("/menus/:id", { onRequest: write, schema: { tags, operationId: "updateMenu", params: idParams, body: menuInput, response: { 200: menuSchema, ...errorResponses } } }, (req) =>
    saveMenu(deps, actorOf(req), sid(req), req.body, req.params.id),
  );
  app.delete("/menus/:id", { onRequest: write, schema: { tags, operationId: "deleteMenu", params: idParams, response: { 200: okBody, ...errorResponses } } }, async (req) => {
    await deleteMenu(deps, actorOf(req), sid(req), req.params.id);
    return ok;
  });

  // ── Redirects ──────────────────────────────────────────────────────────────
  app.get(
    "/redirects",
    {
      onRequest: write,
      schema: {
        tags,
        operationId: "listRedirects",
        querystring: z.object({ query: z.string().max(200).optional(), offset: z.coerce.number().int().min(0).default(0), limit: z.coerce.number().int().min(1).max(500).default(100) }),
        response: { 200: z.object({ items: z.array(redirectSchema), total: z.number().int() }), ...errorResponses },
      },
    },
    (req) => listRedirects(deps.db, sid(req), { offset: req.query.offset, limit: req.query.limit, ...(req.query.query ? { query: req.query.query } : {}) }),
  );
  app.post("/redirects", { onRequest: write, schema: { tags, operationId: "createRedirect", body: redirectInput, response: { 200: redirectSchema, ...errorResponses } } }, (req) =>
    saveRedirect(deps, actorOf(req), sid(req), req.body),
  );
  app.put("/redirects/:id", { onRequest: write, schema: { tags, operationId: "updateRedirect", params: idParams, body: redirectInput, response: { 200: redirectSchema, ...errorResponses } } }, (req) =>
    saveRedirect(deps, actorOf(req), sid(req), req.body, req.params.id),
  );
  app.delete("/redirects/:id", { onRequest: write, schema: { tags, operationId: "deleteRedirect", params: idParams, response: { 200: okBody, ...errorResponses } } }, async (req) => {
    await deleteRedirect(deps, actorOf(req), sid(req), req.params.id);
    return ok;
  });
};

const CACHE = "public, max-age=30, stale-while-revalidate=300";

/** Storefront: theme JSON, CMS content, menus, redirects, sitemaps, analytics config and events. */
export const contentStorefrontRoutes: FastifyPluginAsyncZod<{ deps: AppDeps }> = async (app, { deps }) => {
  const tags = ["storefront"];
  async function storeId(): Promise<string> {
    const store = await getInstallStore(deps.db);
    if (!store || store.status !== "active") throw new AppError("setup_required", "This shop is not open yet");
    return store.id;
  }
  const cache = (reply: FastifyReply) => reply.header("cache-control", CACHE);
  const handle = z.string().min(1).max(255);
  const notFound = () => new AppError("not_found", "Not found");

  app.get(
    "/theme",
    {
      schema: {
        tags,
        operationId: "getStorefrontTheme",
        querystring: z.object({ template: templateName.default("index"), preview: z.string().max(200).optional() }),
        response: { 200: storefrontThemeSchema, ...errorResponses },
      },
    },
    async (req, reply) => {
      const sid = await storeId();
      const draft = !!req.query.preview && verifyPreviewToken(deps, req.query.preview) === sid;
      if (req.query.preview && !draft) throw new AppError("forbidden", "The preview link has expired; reopen the theme editor");
      reply.header("cache-control", draft ? "private, no-store" : CACHE);
      return storefrontTheme(deps, sid, req.query.template, { draft });
    },
  );

  app.get("/pages/:handle", { schema: { tags, operationId: "getStorefrontPage", params: z.object({ handle }), response: { 200: storefrontPageSchema, ...errorResponses } } }, async (req, reply) => {
    const p = await storefrontPage(deps.db, await storeId(), req.params.handle, "page");
    if (!p) throw notFound();
    cache(reply);
    return p;
  });
  app.get("/policies", { schema: { tags, operationId: "listStorefrontPolicies", response: { 200: z.object({ items: z.array(z.object({ title: z.string(), url: z.string() })) }), ...errorResponses } } }, async (_req, reply) => {
    cache(reply);
    return { items: await storefrontPolicies(deps.db, await storeId()) };
  });
  app.get("/policies/:handle", { schema: { tags, operationId: "getStorefrontPolicy", params: z.object({ handle }), response: { 200: storefrontPageSchema, ...errorResponses } } }, async (req, reply) => {
    const p = await storefrontPage(deps.db, await storeId(), req.params.handle, "policy");
    if (!p) throw notFound();
    cache(reply);
    return p;
  });
  app.get(
    "/blogs/:handle",
    {
      schema: {
        tags,
        operationId: "getStorefrontBlog",
        params: z.object({ handle }),
        querystring: z.object({ page: z.coerce.number().int().min(1).max(1000).default(1), tag: z.string().max(60).optional() }),
        response: { 200: storefrontBlogSchema, ...errorResponses },
      },
    },
    async (req, reply) => {
      const b = await storefrontBlog(deps, await storeId(), req.params.handle, { page: req.query.page, ...(req.query.tag ? { tag: req.query.tag } : {}) });
      if (!b) throw notFound();
      cache(reply);
      return b;
    },
  );
  app.get(
    "/blogs/:blog/articles/:handle",
    { schema: { tags, operationId: "getStorefrontArticle", params: z.object({ blog: handle, handle }), response: { 200: storefrontArticleSchema, ...errorResponses } } },
    async (req, reply) => {
      const a = await storefrontArticle(deps, await storeId(), req.params.blog, req.params.handle);
      if (!a) throw notFound();
      cache(reply);
      return a;
    },
  );
  app.get("/menus/:handle", { schema: { tags, operationId: "getStorefrontMenu", params: z.object({ handle }), response: { 200: storefrontMenuSchema, ...errorResponses } } }, async (req, reply) => {
    cache(reply);
    return { items: await storefrontMenu(deps.db, await storeId(), req.params.handle) };
  });
  app.get(
    "/redirect",
    { schema: { tags, operationId: "findRedirect", querystring: z.object({ path: z.string().min(1).max(2000) }), response: { 200: z.object({ to: z.string().nullable() }), ...errorResponses } } },
    async (req, reply) => {
      cache(reply);
      return { to: await findRedirect(deps.db, await storeId(), req.query.path) };
    },
  );
  app.get("/sitemap", { schema: { tags, operationId: "getSitemapIndex", response: { 200: sitemapIndexSchema, ...errorResponses } } }, async (_req, reply) => {
    cache(reply);
    return { items: await sitemapIndex(deps.db, await storeId()) };
  });
  app.get(
    "/sitemap/:type",
    {
      schema: {
        tags,
        operationId: "getSitemapPage",
        params: z.object({ type: z.enum(SITEMAP_TYPES) }),
        querystring: z.object({ page: z.coerce.number().int().min(1).max(10_000).default(1) }),
        response: { 200: sitemapPageSchema, ...errorResponses },
      },
    },
    async (req, reply) => {
      cache(reply);
      return { items: await sitemapEntries(deps.db, await storeId(), req.params.type, req.query.page) };
    },
  );
  app.get("/analytics", { schema: { tags, operationId: "getStorefrontAnalytics", response: { 200: analyticsConfigSchema, ...errorResponses } } }, async (_req, reply) => {
    cache(reply);
    return analyticsConfig(deps, await storeId());
  });

  // Writes: same CSRF header rule as cart/checkout (D-038).
  const requireClient = (h: unknown) => {
    if (h !== "storefront") throw new AppError("forbidden", "Missing X-Shopkit-Client header");
  };
  app.post(
    "/events",
    { config: { rateLimit: { max: 120, timeWindow: "1 minute" } }, schema: { tags, operationId: "recordStorefrontEvents", body: eventsInput, response: { 200: z.object({ accepted: z.number().int() }), ...errorResponses } } },
    async (req, reply) => {
      requireClient(req.headers["x-shopkit-client"]);
      reply.header("cache-control", "no-store");
      return recordEvents(deps, await storeId(), req.body);
    },
  );
  app.post(
    "/newsletter",
    { config: { rateLimit: { max: 5, timeWindow: "1 minute" } }, schema: { tags, operationId: "subscribeNewsletter", body: newsletterInput, response: { 200: okBody, ...errorResponses } } },
    async (req, reply) => {
      requireClient(req.headers["x-shopkit-client"]);
      reply.header("cache-control", "no-store");
      return subscribeNewsletter(deps, await storeId(), req.body);
    },
  );
};
