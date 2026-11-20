import type { Metadata } from "next";
import { RedirectsManager } from "@/components/content/RedirectsManager";
import { serverApi } from "@/lib/api-server";

export const metadata: Metadata = { title: "URL redirects" };

export default async function RedirectsPage() {
  const { data } = await (await serverApi()).GET("/api/admin/redirects", { params: { query: { limit: 100, offset: 0 } } });
  if (!data) return <p>You do not have access to content.</p>;
  return <RedirectsManager initial={data.items} total={data.total} />;
}
