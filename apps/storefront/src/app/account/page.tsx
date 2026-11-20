import type { Metadata } from "next";
import { ThemeShell } from "@/components/ThemeShell";
import { getStore } from "@/lib";
import { AccountPage } from "./AccountPage";

export const metadata: Metadata = { title: "Account", robots: { index: false } };

export default async function Account() {
  const { store } = await getStore();
  return (
    <ThemeShell template="account">
    <div className="sk-container max-w-3xl py-10">
      <AccountPage locale={store?.locale ?? "en"} />
    </div>
    </ThemeShell>
  );
}
