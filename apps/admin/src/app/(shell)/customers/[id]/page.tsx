import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { CustomerDetail } from "@/components/commerce/CustomerDetail";
import { serverApi } from "@/lib/api-server";

export const metadata: Metadata = { title: "Customer" };

export default async function CustomerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const api = await serverApi();
  const { data } = await api.GET("/api/admin/customers/{id}", { params: { path: { id } } });
  if (!data) notFound();
  return <CustomerDetail initial={data} />;
}
