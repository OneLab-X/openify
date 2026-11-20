import type { Metadata } from "next";
import { ThemeShell } from "@/components/ThemeShell";
import { getStore } from "@/lib";
import { CartView } from "./CartView";

export const metadata: Metadata = { title: "Cart", robots: { index: false } };

export default async function CartPage() {
  const { store } = await getStore();
  return (
    <ThemeShell template="cart">
    <div className="sk-container max-w-4xl py-8">
      <h1 className="mb-6 text-2xl font-semibold">Your cart</h1>
      <CartView locale={store?.locale ?? "en"} />
    </div>
    </ThemeShell>
  );
}
