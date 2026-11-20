import { cookies } from "next/headers";
import { PREVIEW_COOKIE } from "@/lib/theme";

/**
 * Theme editor preview entry: checks the signed token with the API and stores it in an httpOnly
 * cookie; theme reads for this browser then fetch the draft, uncached.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token") ?? "";
  const path = url.searchParams.get("path") ?? "/";
  const safePath = path.startsWith("/") && !path.startsWith("//") ? path : "/";
  const api = process.env.API_INTERNAL_URL ?? "http://localhost:4000";
  const check = await fetch(`${api}/api/storefront/theme?template=index&preview=${encodeURIComponent(token)}`, { cache: "no-store" }).catch(() => null);
  if (!check?.ok) return new Response("This preview link has expired. Reopen the theme editor.", { status: 403 });
  (await cookies()).set(PREVIEW_COOKIE, token, { httpOnly: true, secure: url.protocol === "https:" || process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: 2 * 60 * 60 });
  return new Response(null, { status: 303, headers: { location: safePath, "cache-control": "no-store" } });
}
