import { MigrateMedia } from "@/components/MigrateMedia";
import { ProviderSettingsPage } from "@/components/ProviderSettingsPage";
import { serverApi } from "@/lib/api-server";
import { requireMe } from "@/lib/session";

export default async function Page() {
  const me = await requireMe();
  const api = await serverApi();
  const [providers, credentials, settings, jobs] = await Promise.all([
    api.GET("/api/admin/providers", { params: { query: { kind: "storage" } } }),
    api.GET("/api/admin/credentials", { params: { query: { kind: "storage" } } }),
    api.GET("/api/admin/settings"),
    api.GET("/api/admin/jobs", { params: { query: { type: "media_migration" } } }),
  ]);
  if (!providers.data || !credentials.data || !settings.data)
    return <p>You do not have access to this page.</p>;
  return (
    <div className="grid gap-6">
      <ProviderSettingsPage
        kind="storage"
        title="Storage"
        description="Where logos, product images and backups are stored."
        providers={providers.data}
        credentials={credentials.data}
        settings={settings.data}
        publicUrl={me.store.publicUrl ?? ""}
        ownerEmail={me.staff.email}
      />
      <MigrateMedia credentials={credentials.data} active={settings.data.storage} jobs={jobs.data ?? []} />
    </div>
  );
}
