import { z } from "zod";
import { mediaViewSchema } from "./schemas-catalog.js";

/** Response schemas for themes, CMS, navigation, redirects, analytics and sitemaps. */
const iso = z.string();
const settingsValues = z.record(z.string(), z.unknown());

const blockData = z.object({ type: z.string(), disabled: z.boolean().optional(), settings: settingsValues });
const sectionData = z.object({ type: z.string(), disabled: z.boolean().optional(), settings: settingsValues, blocks: z.record(z.string(), blockData), block_order: z.array(z.string()) });
export const templateDataSchema = z.object({ sections: z.record(z.string(), sectionData), order: z.array(z.string()) }).meta({ id: "ThemeTemplate" });

const TEMPLATES = ["layout", "index", "collection", "product", "cart", "search", "page", "blog", "article", "account", "404"] as const;
export const templateName = z.enum(TEMPLATES);

export const themeVersionSchema = z.object({ version: z.number().int(), note: z.string().nullable(), publishedBy: z.uuid().nullable(), createdAt: iso }).meta({ id: "ThemeVersion" });

export const themeEditorSchema = z
  .object({
    theme: z.object({ id: z.uuid(), handle: z.string(), name: z.string(), publishedVersion: z.number().int(), draftUpdatedAt: iso.nullable() }),
    hasDraft: z.boolean(),
    settings: settingsValues,
    templates: z.record(templateName, templateDataSchema),
    versions: z.array(themeVersionSchema),
  })
  .meta({ id: "ThemeEditorState" });

export const themeDraftResultSchema = z
  .object({ issues: z.record(z.string(), z.array(z.object({ path: z.string(), message: z.string() }))) })
  .meta({ id: "ThemeDraftResult" });

export const storefrontThemeSchema = z
  .object({ handle: z.string(), version: z.number().int(), draft: z.boolean(), settings: settingsValues, layout: templateDataSchema, template: templateDataSchema })
  .meta({ id: "StorefrontTheme" });

export const pageSchema = z
  .object({
    id: z.uuid(),
    title: z.string(),
    handle: z.string(),
    bodyHtml: z.string(),
    kind: z.enum(["page", "policy"]),
    policyType: z.enum(["privacy", "terms", "shipping", "refund"]).nullable(),
    published: z.boolean(),
    publishedAt: iso.nullable(),
    seoTitle: z.string().nullable(),
    seoDescription: z.string().nullable(),
    url: z.string(),
    updatedAt: iso,
  })
  .meta({ id: "Page" });
export const storefrontPageSchema = pageSchema.extend({ description: z.string() }).meta({ id: "StorefrontPage" });

export const blogSchema = z
  .object({ id: z.uuid(), title: z.string(), handle: z.string(), seoTitle: z.string().nullable(), seoDescription: z.string().nullable(), articlesCount: z.number().int(), url: z.string(), updatedAt: iso })
  .meta({ id: "Blog" });

export const articleSchema = z
  .object({
    id: z.uuid(),
    blogId: z.uuid(),
    blogHandle: z.string(),
    blogTitle: z.string(),
    title: z.string(),
    handle: z.string(),
    author: z.string().nullable(),
    bodyHtml: z.string(),
    excerpt: z.string().nullable(),
    image: mediaViewSchema.nullable(),
    tags: z.array(z.string()),
    published: z.boolean(),
    publishedAt: iso.nullable(),
    seoTitle: z.string().nullable(),
    seoDescription: z.string().nullable(),
    url: z.string(),
    createdAt: iso,
    updatedAt: iso,
  })
  .meta({ id: "Article" });
export const storefrontArticleSchema = articleSchema.extend({ description: z.string() }).meta({ id: "StorefrontArticle" });
export const storefrontBlogSchema = z
  .object({ blog: blogSchema, items: z.array(articleSchema), page: z.number().int(), pages: z.number().int() })
  .meta({ id: "StorefrontBlog" });

// Menus nest three levels; explicit levels keep the OpenAPI document free of recursive refs.
const itemFields = { id: z.uuid(), title: z.string(), kind: z.string(), resourceId: z.uuid().nullable(), url: z.string().nullable() };
const item3 = z.object({ ...itemFields, items: z.array(z.never()) });
const item2 = z.object({ ...itemFields, items: z.array(item3) });
const item1 = z.object({ ...itemFields, items: z.array(item2) }).meta({ id: "MenuItem" });
export const menuSchema = z.object({ id: z.uuid(), title: z.string(), handle: z.string(), items: z.array(item1) }).meta({ id: "Menu" });

const link3 = z.object({ title: z.string(), url: z.string(), items: z.array(z.never()) });
const link2 = z.object({ title: z.string(), url: z.string(), items: z.array(link3) });
const link1 = z.object({ title: z.string(), url: z.string(), items: z.array(link2) }).meta({ id: "MenuLink" });
export const storefrontMenuSchema = z.object({ items: z.array(link1) }).meta({ id: "StorefrontMenu" });

export const redirectSchema = z.object({ id: z.uuid(), fromPath: z.string(), toPath: z.string(), automatic: z.boolean(), createdAt: iso }).meta({ id: "Redirect" });

export const analyticsConfigSchema = z
  .object({ consentBanner: z.boolean(), providers: z.array(z.object({ id: z.string(), head: z.string(), body: z.string(), requiresConsent: z.boolean() })) })
  .meta({ id: "StorefrontAnalytics" });

export const sitemapIndexSchema = z.object({ items: z.array(z.object({ type: z.enum(["products", "collections", "pages", "blogs"]), pages: z.number().int() })) }).meta({ id: "SitemapIndex" });
export const sitemapPageSchema = z.object({ items: z.array(z.object({ path: z.string(), updatedAt: iso })) }).meta({ id: "SitemapPage" });
