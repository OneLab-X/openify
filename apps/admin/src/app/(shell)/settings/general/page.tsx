import { Card, CardContent, CardHeader, CardTitle } from "@shopkit/ui";
import { serverApi } from "@/lib/api-server";
import { GeneralForm } from "./GeneralForm";

export default async function GeneralSettings() {
  const { data: store } = await (await serverApi()).GET("/api/admin/store");
  if (!store) return null;
  return (
    <Card>
      <CardHeader><CardTitle>Store details</CardTitle></CardHeader>
      <CardContent><GeneralForm store={store} /></CardContent>
    </Card>
  );
}
