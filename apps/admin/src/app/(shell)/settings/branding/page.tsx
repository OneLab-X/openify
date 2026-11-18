import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@shopkit/ui";
import { BrandUpload } from "@/components/BrandUpload";
import { serverApi } from "@/lib/api-server";

export default async function BrandingSettings() {
  const { data: store } = await (await serverApi()).GET("/api/admin/store");
  if (!store) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Branding</CardTitle>
        <CardDescription>Brand colours are under General. Theme fonts arrive with the theme editor.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-6">
        <BrandUpload asset="logo" url="/api/admin/store/logo" current={store.logoUrl} />
        <BrandUpload asset="favicon" url="/api/admin/store/favicon" current={store.faviconUrl} />
      </CardContent>
    </Card>
  );
}
