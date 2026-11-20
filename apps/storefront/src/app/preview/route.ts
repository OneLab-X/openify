import { cookies, draftMode } from "next/headers";
import { redirect } from "next/navigation";
import { PREVIEW_COOKIE } from "@/lib/theme";

/**
 * Theme editor preview entry: checks the signed token with the API, turns on Draft Mode (which
 * bypasses the data cache for this browser only) and remembers the token for theme reads.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token") ?? "";
  const path = url.searchParams.get("path") ?? "/";
  const safePath = path.startsWith("/") && !path.startsWith("//") ? path : "/";
  const api = process.env.API_INTERNAL_URL ?? "http://localhost:4000";
  const check = await fetch(`${api}/api/storefront/theme?template=index&preview=${encodeURIComponent(token)}`, { cache: "no-store" }).catch(() => null);
  if (!check?.ok) return new Response("This preview link has expired. Reopen the theme editor.", { status: 403 });
  (await draftMode()).enable();
  (await cookies()).set(PREVIEW_COOKIE, token, { httpOnly: true, secure: url.protocol === "https:" || process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: 2 * 60 * 60 });
  redirect(safePath);
}
