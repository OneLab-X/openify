import { revalidateTag } from "next/cache";
import { timingSafeEqual, createHash } from "node:crypto";

const digest = (v: string) => createHash("sha256").update(v).digest();

/** Called by the worker (shared REVALIDATE_SECRET) when catalog/store data changes (SPEC §4). */
export async function POST(request: Request) {
  const secret = process.env.REVALIDATE_SECRET;
  const given = request.headers.get("x-revalidate-secret") ?? "";
  if (!secret || !timingSafeEqual(digest(secret), digest(given))) {
    return Response.json({ ok: false }, { status: 401 });
  }
  const body = (await request.json().catch(() => ({}))) as { tags?: unknown };
  const tags = Array.isArray(body.tags) ? body.tags.filter((t): t is string => typeof t === "string").slice(0, 50) : [];
  // Expire immediately: the next visit after a catalog change renders fresh data (the phase target is
  // "visible on the storefront within 5 seconds"), instead of serving stale content once.
  for (const tag of tags) revalidateTag(tag, { expire: 0 });
  return Response.json({ ok: true, revalidated: tags });
}
