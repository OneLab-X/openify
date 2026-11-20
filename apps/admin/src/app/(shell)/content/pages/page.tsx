import type { Metadata } from "next";
import { PagesManager } from "@/components/content/PagesManager";
import { serverApi } from "@/lib/api-server";

export const metadata: Metadata = { title: "Pages" };

export default async function PagesPage() {
  const { data } = await (await serverApi()).GET("/api/admin/pages");
  if (!data) return <p>You do not have access to content.</p>;
  return <PagesManager initial={data.items} />;
}
