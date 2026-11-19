import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@shopkit/ui";
import { ShippingZonesEditor } from "@/components/ShippingZonesEditor";
import { TaxRatesEditor } from "@/components/TaxRatesEditor";
import { serverApi } from "@/lib/api-server";
import { requireMe } from "@/lib/session";
import { ShippingSettingsForm } from "./ShippingSettingsForm";

export default async function ShippingSettings() {
  const me = await requireMe();
  const api = await serverApi();
  const [settings, shipping, tax, locations, couriers, collections] = await Promise.all([
    api.GET("/api/admin/settings"),
    api.GET("/api/admin/shipping"),
    api.GET("/api/admin/tax"),
    api.GET("/api/admin/locations"),
    api.GET("/api/admin/couriers"),
    api.GET("/api/admin/collections", { params: { query: { limit: 200 } } }),
  ]);
  if (!settings.data) return <p>You do not have access to this page.</p>;
  const currency = me.store.currency ?? "INR";
  return (
    <div className="grid gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Defaults</CardTitle>
          <CardDescription>The flat rate used when no shipping zone is set up, and how taxes are calculated.</CardDescription>
        </CardHeader>
        <CardContent>
          <ShippingSettingsForm settings={settings.data} currency={currency} />
        </CardContent>
      </Card>
      {shipping.data ? (
        <ShippingZonesEditor
          initial={shipping.data}
          currency={currency}
          locations={(locations.data ?? []).filter((l) => l.active).map((l) => ({ id: l.id, name: l.name }))}
          carriers={couriers.data?.carriers ?? []}
        />
      ) : null}
      {tax.data ? <TaxRatesEditor initial={tax.data} config={settings.data.tax} collections={(collections.data ?? []).map((c) => ({ id: c.id, title: c.title }))} /> : null}
    </div>
  );
}
