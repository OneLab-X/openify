import { Card, CardContent, CardHeader, CardTitle } from "@shopkit/ui";
import { serverApi } from "@/lib/api-server";
import { AuditTable } from "./AuditTable";

export default async function AuditLogPage() {
  const api = await serverApi();
  const [{ data }, team] = await Promise.all([api.GET("/api/admin/audit", { params: { query: { limit: 50 } } }), api.GET("/api/admin/team")]);
  if (!data) return <p>You do not have access to this page.</p>;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Audit log</CardTitle>
      </CardHeader>
      <CardContent>
        <AuditTable initial={data} staff={(team.data?.items ?? []).map((s) => ({ id: s.id, name: s.name }))} />
      </CardContent>
    </Card>
  );
}
