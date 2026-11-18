import { createShopkitClient, type Schemas } from "@shopkit/sdk";

export type StorefrontStore = Schemas["StorefrontStore"];

const apiOrigin = () => process.env.API_INTERNAL_URL ?? "http://localhost:4000";

/** Store identity for the shell. Tagged so the worker can revalidate it (`theme` tag, SPEC §4). */
export async function getStore(): Promise<StorefrontStore> {
  const api = createShopkitClient({
    baseUrl: apiOrigin(),
    fetch: (req) => fetch(req, { next: { revalidate: 60, tags: ["store"] } }),
  });
  try {
    const { data } = await api.GET("/api/storefront/store");
    return data ?? { setupRequired: true, store: null };
  } catch {
    return { setupRequired: true, store: null };
  }
}
