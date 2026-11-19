import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DraftEditor } from "@/components/commerce/DraftEditor";
import { serverApi } from "@/lib/api-server";

export const metadata: Metadata = { title: "Draft order" };

export default async function DraftPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const api = await serverApi();
  const { data } = await api.GET("/api/admin/draft-orders/{id}", { params: { path: { id } } });
  if (!data) notFound();
  return <DraftEditor initial={data} />;
}
