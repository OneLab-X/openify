import { ProviderSettingsPage } from "@/components/ProviderSettingsPage";
import { serverApi } from "@/lib/api-server";
import { requireMe } from "@/lib/session";

export default async function Page() {
  const me = await requireMe();
  const api = await serverApi();
  const [providers, credentials, settings] = await Promise.all([
    api.GET("/api/admin/providers", { params: { query: { kind: "payment" } } }),
    api.GET("/api/admin/credentials", { params: { query: { kind: "payment" } } }),
    api.GET("/api/admin/settings"),
  ]);
  if (!providers.data || !credentials.data || !settings.data) return <p>You do not have access to this page.</p>;
  return (
    <ProviderSettingsPage
      kind="payment"
      title="Payments"
      description="Payment methods offered at checkout."
      providers={providers.data}
      credentials={credentials.data}
      settings={settings.data}
      publicUrl={me.store.publicUrl ?? ""}
      ownerEmail={me.staff.email}
    />
  );
}
