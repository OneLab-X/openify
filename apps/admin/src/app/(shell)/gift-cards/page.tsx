import type { Metadata } from "next";
import { GiftCardsManager } from "@/components/commerce/GiftCardsManager";
import { serverApi } from "@/lib/api-server";
import { can, requireMe } from "@/lib/session";

export const metadata: Metadata = { title: "Gift cards" };

export default async function GiftCardsPage() {
  const me = await requireMe();
  const api = await serverApi();
  const { data } = await api.GET("/api/admin/gift-cards");
  if (!data) return <p>You do not have access to gift cards.</p>;
  return <GiftCardsManager initial={data.items} currency={me.store.currency ?? "USD"} canWrite={can(me, "gift_cards:write")} />;
}
