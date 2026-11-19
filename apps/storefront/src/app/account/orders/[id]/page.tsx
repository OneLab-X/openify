import type { Metadata } from "next";
import { getStore } from "@/lib";
import { AccountOrder } from "./AccountOrder";

export const metadata: Metadata = { title: "Order", robots: { index: false } };

export default async function AccountOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { store } = await getStore();
  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <AccountOrder id={id} locale={store?.locale ?? "en"} />
    </main>
  );
}
