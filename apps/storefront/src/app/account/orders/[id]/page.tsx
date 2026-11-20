import type { Metadata } from "next";
import { ThemeShell } from "@/components/ThemeShell";
import { getStore } from "@/lib";
import { AccountOrder } from "./AccountOrder";

export const metadata: Metadata = { title: "Order", robots: { index: false } };

export default async function AccountOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { store } = await getStore();
  return (
    <ThemeShell template="account">
      <div className="sk-container max-w-3xl py-10">
        <AccountOrder id={id} locale={store?.locale ?? "en"} />
      </div>
    </ThemeShell>
  );
}
