import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@shopkit/ui";
import { serverApi } from "@/lib/api-server";
import { requireMe } from "@/lib/session";
import { ShippingSettingsForm } from "./ShippingSettingsForm";

export default async function ShippingSettings() {
  const me = await requireMe();
  const { data } = await (await serverApi()).GET("/api/admin/settings");
  if (!data) return <p>You do not have access to this page.</p>;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Shipping & taxes</CardTitle>
        <CardDescription>Default zone, flat rate and tax mode. Ship-from locations get their own page with inventory.</CardDescription>
      </CardHeader>
      <CardContent>
        <ShippingSettingsForm settings={data} currency={me.store.currency ?? "INR"} />
      </CardContent>
    </Card>
  );
}
