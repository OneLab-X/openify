import { content, getStore } from "@/lib";
import { siteUrl } from "@/lib/seo";

/** Built from live data on each request (cached by the CDN headers), never at build time. */
export const dynamic = "force-dynamic";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Sitemap index split by type (SPEC §11): /sitemaps/<type>-<n>.xml */
export async function GET() {
  const [{ store }, { data }] = await Promise.all([getStore(), content(["products", "collections", "content"]).GET("/api/storefront/sitemap")]);
  const base = siteUrl(store);
  const items = (data?.items ?? []).flatMap((t) => Array.from({ length: t.pages }, (_, i) => `${base}/sitemaps/${t.type}-${i + 1}.xml`));
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${items.map((u) => `  <sitemap><loc>${esc(u)}</loc></sitemap>`).join("\n")}\n</sitemapindex>\n`;
  return new Response(xml, { headers: { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=600" } });
}
