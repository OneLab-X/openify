import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { OrderDetail } from "@/components/commerce/OrderDetail";
import { serverApi } from "@/lib/api-server";

export const metadata: Metadata = { title: "Order" };

export default async function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const api = await serverApi();
  const { data } = await api.GET("/api/admin/orders/{id}", { params: { path: { id } } });
  if (!data) notFound();
  return <OrderDetail initial={data} />;
}
