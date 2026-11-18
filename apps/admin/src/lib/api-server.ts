import { createShopkitClient } from "@shopkit/sdk";
import { cookies } from "next/headers";

/** API origin for server components: the internal service URL (never exposed to the browser). */
export const apiOrigin = () => process.env.API_INTERNAL_URL ?? "http://localhost:4000";

/** Server-side SDK client that forwards the visitor's cookies (session, setup token). */
export async function serverApi() {
  const jar = await cookies();
  const cookie = jar.getAll().map((c) => `${c.name}=${encodeURIComponent(c.value)}`).join("; ");
  return createShopkitClient({ baseUrl: apiOrigin(), headers: cookie ? { cookie } : {}, fetch: (req) => fetch(req, { cache: "no-store" }) });
}
