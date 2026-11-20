import { createShopkitClient, type Schemas } from "@shopkit/sdk";

export type StorefrontStore = Schemas["StorefrontStore"];
export type ProductCard = Schemas["ProductCard"];
export type StorefrontProduct = Schemas["StorefrontProduct"];
export type StorefrontCollection = Schemas["StorefrontCollection"];
export type Media = Schemas["Media"];
export type Facets = Schemas["StorefrontFacets"];

const apiOrigin = () => process.env.API_INTERNAL_URL ?? "http://localhost:4000";

/**
 * Server-side SDK client. Responses are kept in Next's data cache under `tags` until the worker
 * revalidates them (outbox → /internal/revalidate, SPEC §4); `revalidate` is only a safety net.
 * The shared secret lets SSR traffic (one container IP for every shopper) skip the per-IP limit.
 */
function api(tags: string[]) {
  const secret = process.env.REVALIDATE_SECRET;
  return createShopkitClient({
    baseUrl: apiOrigin(),
    ...(secret ? { headers: { "x-shopkit-internal": secret } } : {}),
    fetch: (req) => fetch(req, { cache: "force-cache", next: { revalidate: 3600, tags } }),
  });
}

/** SDK client for content reads: tagged cache, or `null` tags for uncached (preview) reads. */
export function content(tags: string[] | null) {
  if (tags) return api(tags);
  const secret = process.env.REVALIDATE_SECRET;
  return createShopkitClient({
    baseUrl: apiOrigin(),
    ...(secret ? { headers: { "x-shopkit-internal": secret } } : {}),
    fetch: (req) => fetch(req, { cache: "no-store" }),
  });
}

export async function getPage(handle: string, kind: "page" | "policy") {
  const c = content(["content"]);
  const { data } = kind === "page" ? await c.GET("/api/storefront/pages/{handle}", { params: { path: { handle } } }) : await c.GET("/api/storefront/policies/{handle}", { params: { path: { handle } } });
  return data ?? null;
}

export async function getBlog(handle: string, page = 1, tag?: string) {
  const { data } = await content(["content"]).GET("/api/storefront/blogs/{handle}", { params: { path: { handle }, query: { page, ...(tag ? { tag } : {}) } } });
  return data ?? null;
}

export async function getArticle(blog: string, handle: string) {
  const { data } = await content(["content"]).GET("/api/storefront/blogs/{blog}/articles/{handle}", { params: { path: { blog, handle } } });
  return data ?? null;
}

export async function findRedirect(path: string) {
  const { data } = await content(["redirects"]).GET("/api/storefront/redirect", { params: { query: { path } } });
  return data?.to ?? null;
}

/** Analytics snippets: credential changes are not outbox events, so this refreshes every 5 minutes. */
export async function getAnalyticsConfig() {
  try {
    const secret = process.env.REVALIDATE_SECRET;
    const client = createShopkitClient({
      baseUrl: apiOrigin(),
      ...(secret ? { headers: { "x-shopkit-internal": secret } } : {}),
      fetch: (req) => fetch(req, { cache: "force-cache", next: { revalidate: 300, tags: ["analytics", "store"] } }),
    });
    const { data } = await client.GET("/api/storefront/analytics");
    return data ?? { consentBanner: true, providers: [] };
  } catch {
    return { consentBanner: true, providers: [] };
  }
}

/** Store identity for the shell (`store` tag). */
export async function getStore(): Promise<StorefrontStore> {
  try {
    const { data } = await api(["store"]).GET("/api/storefront/store");
    return data ?? { setupRequired: true, store: null };
  } catch {
    return { setupRequired: true, store: null };
  }
}

export type ListQuery = {
  sort?: Schemas["StorefrontCollection"]["sortOrder"];
  limit?: number;
  cursor?: string;
  priceMin?: number;
  priceMax?: number;
  available?: "true" | "false";
  tag?: string[];
  vendor?: string[];
  option?: string[];
};

export async function listProducts(query: ListQuery = {}) {
  const { data } = await api(["products"]).GET("/api/storefront/products", { params: { query } });
  return data ?? { items: [], nextCursor: null };
}

export async function getProduct(handle: string) {
  const { data } = await api(["products", `product-handle:${handle.toLowerCase()}`]).GET("/api/storefront/products/{handle}", { params: { path: { handle } } });
  return data ?? null;
}

export async function listCollections() {
  const { data } = await api(["collections"]).GET("/api/storefront/collections", { params: { query: { limit: 50 } } });
  return data?.items ?? [];
}

export async function getCollection(handle: string) {
  const { data } = await api(["collections", `collection-handle:${handle.toLowerCase()}`]).GET("/api/storefront/collections/{handle}", { params: { path: { handle } } });
  return data ?? null;
}

export async function listCollectionProducts(handle: string, query: ListQuery = {}) {
  const { data } = await api(["products", "collections", `collection-handle:${handle.toLowerCase()}`]).GET("/api/storefront/collections/{handle}/products", {
    params: { path: { handle }, query },
  });
  return data ?? { items: [], nextCursor: null };
}

export async function getFacets(collection?: string) {
  const { data } = await api(["products", "collections"]).GET("/api/storefront/facets", { params: { query: collection ? { collection } : {} } });
  return data ?? null;
}

export async function search(q: string, cursor?: string) {
  const { data } = await api(["products"]).GET("/api/storefront/search", { params: { query: { q, limit: 24, ...(cursor ? { cursor } : {}) } } });
  return data ?? { items: [], total: 0, nextCursor: null };
}

export function currencyDigits(currency: string): number {
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

/** Integer minor units → localised price. */
export function formatMoney(minor: number, currency: string, locale = "en"): string {
  const digits = currencyDigits(currency);
  return new Intl.NumberFormat(locale, { style: "currency", currency, minimumFractionDigits: digits }).format(minor / 10 ** digits);
}

/** Next's searchParams → a flat list of values. */
export function many(v: string | string[] | undefined): string[] {
  return v === undefined ? [] : Array.isArray(v) ? v : [v];
}
export function one(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export type OrderPublic = Schemas["OrderPublic"];

/** Order status by signed token; never cached (payment state changes). */
export async function getOrderStatus(token: string): Promise<OrderPublic | null> {
  const secret = process.env.REVALIDATE_SECRET;
  const client = createShopkitClient({
    baseUrl: apiOrigin(),
    ...(secret ? { headers: { "x-shopkit-internal": secret } } : {}),
    fetch: (req) => fetch(req, { cache: "no-store" }),
  });
  const { data } = await client.GET("/api/storefront/orders/{token}", { params: { path: { token } } });
  return data ?? null;
}
