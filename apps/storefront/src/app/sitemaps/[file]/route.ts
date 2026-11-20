import { content, getStore } from "@/lib";
import { siteUrl } from "@/lib/seo";

/** Built from live data on each request (cached by the CDN headers), never at build time. */
export const dynamic = "force-dynamic";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const TYPES = ["products", "collections", "pages", "blogs"] as const;

export async function GET(_req: Request, { params }: { params: Promise<{ file: string }> }) {
  const m = /^(products|collections|pages|blogs)-(\d{1,5})\.xml$/.exec((await params).file);
  if (!m || !TYPES.includes(m[1] as (typeof TYPES)[number])) return new Response("Not found", { status: 404 });
  const type = m[1] as (typeof TYPES)[number];
  const [{ store }, { data }] = await Promise.all([
    getStore(),
    content(["products", "collections", "content"]).GET("/api/storefront/sitemap/{type}", { params: { path: { type }, query: { page: Number(m[2]) } } }),
  ]);
  const base = siteUrl(store);
  const urls = data?.items ?? [];
  if (!urls.length && Number(m[2]) > 1) return new Response("Not found", { status: 404 });
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls
    .map((u) => `  <url><loc>${esc(base + encodeURI(u.path))}</loc><lastmod>${u.updatedAt.slice(0, 10)}</lastmod></url>`)
    .join("\n")}\n</urlset>\n`;
  return new Response(xml, { headers: { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=600" } });
}
