import { notFound, permanentRedirect } from "next/navigation";
import { findRedirect } from "@/lib";

/** Any URL no route matched: follow a merchant or automatic redirect (301), else 404. */
export default async function CatchAll({ params, searchParams }: { params: Promise<{ path: string[] }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { path } = await params;
  const to = await findRedirect(`/${path.map(encodeURIComponent).join("/")}`);
  if (!to) notFound();
  const sp = await searchParams;
  const qs = new URLSearchParams(Object.entries(sp).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => [k, x]) : v === undefined ? [] : [[k, v]]))).toString();
  permanentRedirect(qs && to.startsWith("/") ? `${to}${to.includes("?") ? "&" : "?"}${qs}` : to);
}
