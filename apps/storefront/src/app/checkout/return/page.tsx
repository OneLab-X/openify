import type { Metadata } from "next";
import { ReturnVerifier } from "./ReturnVerifier";

export const metadata: Metadata = { title: "Confirming payment", robots: { index: false } };

/** Redirect providers (Stripe, PayPal, Cashfree, PhonePe) bring the shopper back here. */
export default async function ReturnPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const raw = await searchParams;
  const params = Object.fromEntries(Object.entries(raw).flatMap(([k, v]) => (typeof v === "string" ? [[k, v]] : [])));
  return (
    <main className="sk-container max-w-xl py-16 text-center">
      <ReturnVerifier params={params} />
    </main>
  );
}
