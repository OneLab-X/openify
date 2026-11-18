import { Badge, Card, CardContent, CardHeader, CardTitle } from "@shopkit/ui";
import { serverApi } from "@/lib/api-server";
import { requireMe } from "@/lib/session";
import { TwoFactor } from "./TwoFactor";

export default async function StaffSettings() {
  const me = await requireMe();
  const { data: staff } = await (await serverApi()).GET("/api/admin/staff");
  return (
    <div className="grid gap-6">
      <Card>
        <CardHeader><CardTitle>Your security</CardTitle></CardHeader>
        <CardContent><TwoFactor enabled={me.staff.totpEnabled} /></CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Staff</CardTitle></CardHeader>
        <CardContent>
          <table className="w-full text-left text-sm">
            <thead className="text-muted-foreground">
              <tr><th className="py-2">Name</th><th>Email</th><th>Role</th><th>2FA</th><th>Last sign-in</th></tr>
            </thead>
            <tbody>
              {(staff ?? []).map((s) => (
                <tr key={s.id} className="border-t border-border">
                  <td className="py-2">{s.name}</td>
                  <td>{s.email}</td>
                  <td><Badge variant="secondary">{s.roleName}</Badge></td>
                  <td>{s.totpEnabled ? <Badge variant="success">On</Badge> : <Badge variant="outline">Off</Badge>}</td>
                  <td>{s.lastLoginAt ? new Date(s.lastLoginAt).toLocaleString() : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-4 text-xs text-muted-foreground">Inviting staff arrives with merchant operations.</p>
        </CardContent>
      </Card>
    </div>
  );
}
