import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { SetupWizard } from "@/components/wizard/SetupWizard";
import { serverApi } from "@/lib/api-server";

export const metadata: Metadata = { title: "Set up your store" };

export default async function SetupPage() {
  const api = await serverApi();
  const { data } = await api.GET("/api/setup/status");
  if (data && !data.required) redirect("/login");
  return (
    <main className="mx-auto max-w-5xl px-4 py-10">
      <h1 className="mb-1 text-2xl font-semibold">Set up your store</h1>
      <p className="mb-8 text-sm text-muted-foreground">Everything here can be changed later in Settings.</p>
      <SetupWizard />
    </main>
  );
}
