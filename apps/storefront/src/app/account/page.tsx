import type { Metadata } from "next";
import { getStore } from "@/lib";
import { AccountPage } from "./AccountPage";

export const metadata: Metadata = { title: "Account", robots: { index: false } };

export default async function Account() {
  const { store } = await getStore();
  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      <AccountPage locale={store?.locale ?? "en"} />
    </main>
  );
}
