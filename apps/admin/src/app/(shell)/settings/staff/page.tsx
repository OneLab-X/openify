import { Card, CardContent, CardHeader, CardTitle } from "@shopkit/ui";
import { TeamManager } from "@/components/TeamManager";
import { serverApi } from "@/lib/api-server";
import { can, requireMe } from "@/lib/session";
import { TwoFactor } from "./TwoFactor";

export default async function StaffSettings() {
  const me = await requireMe();
  const api = await serverApi();
  const [team, roles, invites, groups, settings] = await Promise.all([
    api.GET("/api/admin/team"),
    api.GET("/api/admin/roles"),
    api.GET("/api/admin/invites"),
    api.GET("/api/admin/permissions"),
    api.GET("/api/admin/settings"),
  ]);
  return (
    <div className="grid gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Your security</CardTitle>
        </CardHeader>
        <CardContent>
          <TwoFactor enabled={me.staff.totpEnabled} />
        </CardContent>
      </Card>
      {team.data && roles.data && invites.data && groups.data ? (
        <TeamManager
          meId={me.staff.id}
          team={team.data.items}
          roles={roles.data.items}
          invites={invites.data.items}
          groups={groups.data}
          requireTwoFactor={settings.data?.security?.requireTwoFactor ?? false}
          canManage={can(me, "settings:staff")}
          canSecurity={can(me, "settings:security")}
        />
      ) : (
        <p>You do not have access to staff settings.</p>
      )}
    </div>
  );
}
