import type { Metadata } from "next";
import { DiscountsManager } from "@/components/commerce/DiscountsManager";
import { serverApi } from "@/lib/api-server";
import { requireMe } from "@/lib/session";

export const metadata: Metadata = { title: "Discounts" };

export default async function DiscountsPage() {
  const me = await requireMe();
  const api = await serverApi();
  const list = await api.GET("/api/admin/discounts");
  if (!list.data) return <p>You do not have access to discounts.</p>;
  return <DiscountsManager initial={list.data.items} currency={me.store.currency ?? "USD"} />;
}
