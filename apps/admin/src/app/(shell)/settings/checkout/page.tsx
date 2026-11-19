import type { Metadata } from "next";
import { CheckoutSettingsForm } from "@/components/commerce/CheckoutSettingsForm";
import { serverApi } from "@/lib/api-server";

export const metadata: Metadata = { title: "Checkout settings" };

export default async function CheckoutSettingsPage() {
  const api = await serverApi();
  const { data } = await api.GET("/api/admin/settings");
  if (!data?.checkout) return <p>You do not have access to settings.</p>;
  return <CheckoutSettingsForm initial={data.checkout} />;
}
