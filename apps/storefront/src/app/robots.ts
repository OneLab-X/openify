import type { MetadataRoute } from "next";
import { getStore } from "@/lib";
import { siteUrl } from "@/lib/seo";

export default async function robots(): Promise<MetadataRoute.Robots> {
  const { store } = await getStore();
  const base = siteUrl(store);
  return {
    rules: { userAgent: "*", allow: "/", disallow: ["/admin", "/api/", "/cart", "/checkout", "/orders/", "/account", "/search", "/preview", "/*?*sort=", "/*?*cursor="] },
    sitemap: `${base}/sitemap.xml`,
    host: base,
  };
}
