import type { Metadata } from "next";
import { getStore } from "@/lib";
import { CheckoutForm } from "./CheckoutForm";

export const metadata: Metadata = { title: "Checkout", robots: { index: false } };

export default async function CheckoutPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const { store } = await getStore();
  const id = typeof params.id === "string" ? params.id : null;
  const error = typeof params.error === "string" ? params.error : null;
  return (
    <main className="sk-container max-w-5xl py-8">
      <h1 className="mb-6 text-2xl font-semibold">Checkout</h1>
      <CheckoutForm checkoutId={id} shopName={store?.name ?? "Shop"} locale={store?.locale ?? "en"} initialError={error} />
    </main>
  );
}
