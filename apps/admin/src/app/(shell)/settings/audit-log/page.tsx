import { Card, CardContent, CardHeader, CardTitle } from "@shopkit/ui";
import { serverApi } from "@/lib/api-server";
import { AuditTable } from "./AuditTable";

export default async function AuditLogPage() {
  const { data } = await (await serverApi()).GET("/api/admin/audit-logs", { params: { query: { limit: 50 } } });
  if (!data) return <p>You do not have access to this page.</p>;
  return (
    <Card>
      <CardHeader><CardTitle>Audit log</CardTitle></CardHeader>
      <CardContent><AuditTable initial={data} /></CardContent>
    </Card>
  );
}
