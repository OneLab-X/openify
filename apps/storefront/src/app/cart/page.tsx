import type { Metadata } from "next";
import { getStore } from "@/lib";
import { CartView } from "./CartView";

export const metadata: Metadata = { title: "Cart", robots: { index: false } };

export default async function CartPage() {
  const { store } = await getStore();
  return (
    <main className="mx-auto max-w-4xl px-4 py-8">
      <h1 className="mb-6 text-2xl font-semibold">Your cart</h1>
      <CartView locale={store?.locale ?? "en"} />
    </main>
  );
}
