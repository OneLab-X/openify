import { globalSettings, type ThemeContext, type ThemeData, type ThemeImage, type ThemeProductCard } from "@shopkit/theme-default";
import type { TemplateName } from "@shopkit/theme-sdk";
import { cookies, draftMode } from "next/headers";
import { cache } from "react";
import { content, getCollection, getProduct, getStore, listCollectionProducts, listProducts, type Media, type ProductCard } from "./index";

export const PREVIEW_COOKIE = "sk_preview";

/** The editor's preview token, only while Draft Mode is on (set by /preview). */
export const previewToken = cache(async (): Promise<string | null> => {
  const draft = await draftMode();
  if (!draft.isEnabled) return null;
  return (await cookies()).get(PREVIEW_COOKIE)?.value ?? null;
});

/** Theme JSON for a template: live (cached under the `theme` tag) or the editor's draft. */
export const getTheme = cache(async (template: TemplateName) => {
  const preview = await previewToken();
  try {
    const { data } = await content(preview ? null : ["theme"]).GET("/api/storefront/theme", { params: { query: { template, ...(preview ? { preview } : {}) } } });
    return data ?? null;
  } catch {
    return null; // API unreachable: pages fall back to unthemed content
  }
});

const toImage = (m: Media | null | undefined): ThemeImage | null => (m ? { url: m.url, alt: m.alt, width: m.width, height: m.height, sources: m.sources } : null);
const toCard = (p: ProductCard): ThemeProductCard => ({
  handle: p.handle,
  title: p.title,
  priceMin: p.priceMin,
  priceMax: p.priceMax,
  compareAtPriceMax: p.compareAtPriceMax,
  currency: p.currency,
  available: p.available,
  image: toImage(p.image),
});

const data: ThemeData = {
  async products({ collection, limit }) {
    if (collection) {
      const c = await getCollection(collection);
      if (!c) return { title: null, url: "/collections", items: [] };
      const page = await listCollectionProducts(collection, { limit });
      return { title: c.title, url: `/collections/${c.handle}`, items: page.items.map(toCard) };
    }
    const page = await listProducts({ sort: "created_desc", limit });
    return { title: null, url: "/search", items: page.items.map(toCard) };
  },
  async product(handle) {
    const p = await getProduct(handle);
    if (!p) return null;
    return { ...toCard({ ...p, image: p.images[0] ?? null }), vendor: p.vendor, descriptionHtml: p.descriptionHtml };
  },
  async menu(handle) {
    const { data: m } = await content(["content"]).GET("/api/storefront/menus/{handle}", { params: { path: { handle } } });
    return m?.items ?? [];
  },
  async policies() {
    const { data: p } = await content(["content"]).GET("/api/storefront/policies");
    return p?.items ?? [];
  },
};

/** Everything a page needs to render the theme around its own content. */
export async function themeContext(template: TemplateName, slots: ThemeContext["slots"], main?: React.ReactNode) {
  const [theme, { store }] = await Promise.all([getTheme(template), getStore()]);
  if (!theme || !store) return null;
  const ctx: ThemeContext = {
    store: { name: store.name, logo: store.logoUrl ? { url: store.logoUrl, alt: store.name } : null, locale: store.locale ?? "en", currency: store.currency ?? "USD" },
    settings: globalSettings(theme.settings, store.brand),
    data,
    template,
    slots,
    ...(main ? { main } : {}),
  };
  return { ctx, theme };
}
