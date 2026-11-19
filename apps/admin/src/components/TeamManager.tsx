"use client";
import type { Schemas } from "@shopkit/sdk";
import { Alert, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Checkbox, Input, Label, Select } from "@shopkit/ui";
import { useState } from "react";
import { api, errorMessage } from "@/lib/api-client";

type Member = Schemas["TeamMember"];
type Role = Schemas["Role"];
type Invite = Schemas["StaffInvite"];
type Groups = Schemas["PermissionGroups"];

const PERMISSION_LABEL = (p: string) => p.replace(/_/g, " ").replace(":", " · ");

/** Staff accounts, invitations, custom roles with granular permissions, and the 2FA policy. */
export function TeamManager(props: { meId: string; team: Member[]; roles: Role[]; invites: Invite[]; groups: Groups; requireTwoFactor: boolean; canManage: boolean; canSecurity: boolean }) {
  const { meId, groups, canManage, canSecurity } = props;
  const [team, setTeam] = useState(props.team);
  const [roles, setRoles] = useState(props.roles);
  const [invites, setInvites] = useState(props.invites);
  const [require2fa, setRequire2fa] = useState(props.requireTwoFactor);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [invite, setInvite] = useState({ email: "", name: "", roleId: roles.find((r) => r.key === "staff")?.id ?? roles[0]?.id ?? "" });
  const [editing, setEditing] = useState<Role | "new" | null>(null);
  const assignable = roles.filter((r) => r.key !== "owner");
  const done = (text: string) => setMsg({ ok: true, text });
  const fail = (e: unknown) => setMsg({ ok: false, text: errorMessage(e) });

  async function sendInvite() {
    const { data, error } = await api.POST("/api/admin/invites", { body: { email: invite.email, roleId: invite.roleId, ...(invite.name ? { name: invite.name } : {}) } });
    if (!data) return fail(error);
    setInvites(data.items);
    setInvite({ ...invite, email: "", name: "" });
    done(`Invitation sent to ${invite.email}`);
  }
  async function updateMember(m: Member, body: { roleId?: string; disabled?: boolean }) {
    const { data, error } = await api.PATCH("/api/admin/team/{id}", { params: { path: { id: m.id } }, body });
    if (!data) return fail(error);
    setTeam(data.items);
    done(`${m.name} updated`);
  }
  async function toggle2fa(next: boolean) {
    const { error } = await api.PUT("/api/admin/security", { body: { requireTwoFactor: next } });
    if (error) return fail(error);
    setRequire2fa(next);
    done(next ? "Two-factor authentication is now required for all staff" : "Two-factor authentication is optional");
  }

  return (
    <>
      {msg ? <Alert variant={msg.ok ? "success" : "error"}>{msg.text}</Alert> : null}
      {canSecurity ? (
        <Card>
          <CardHeader>
            <CardTitle>Security policy</CardTitle>
            <CardDescription>When required, staff without two-factor authentication must set it up before they can use the admin.</CardDescription>
          </CardHeader>
          <CardContent>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={require2fa} onChange={(e) => void toggle2fa(e.target.checked)} /> Require two-factor authentication for all staff
            </label>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Staff</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="text-muted-foreground">
                <tr>
                  <th className="py-2 font-medium">Name</th>
                  <th className="font-medium">Role</th>
                  <th className="font-medium">2FA</th>
                  <th className="font-medium">Last sign-in</th>
                  <th>
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {team.map((m) => (
                  <tr key={m.id} className="border-t border-border">
                    <td className="py-2">
                      {m.name}
                      <span className="block text-xs text-muted-foreground">{m.email}</span>
                    </td>
                    <td>
                      {canManage && m.role !== "owner" && m.id !== meId ? (
                        <Select aria-label={`Role of ${m.name}`} className="h-8 w-40" value={m.roleId} onChange={(e) => void updateMember(m, { roleId: e.target.value })}>
                          {assignable.map((r) => (
                            <option key={r.id} value={r.id}>
                              {r.name}
                            </option>
                          ))}
                        </Select>
                      ) : (
                        <Badge variant="secondary">{m.roleName}</Badge>
                      )}
                    </td>
                    <td>{m.totpEnabled ? <Badge variant="success">On</Badge> : <Badge variant={m.twoFactorSetupRequired ? "warning" : "outline"}>{m.twoFactorSetupRequired ? "Required" : "Off"}</Badge>}</td>
                    <td>{m.lastLoginAt ? new Date(m.lastLoginAt).toLocaleString() : "—"}</td>
                    <td className="text-right">
                      {canManage && m.role !== "owner" && m.id !== meId ? (
                        <Button size="sm" variant="ghost" onClick={() => void updateMember(m, { disabled: !m.disabled })}>
                          {m.disabled ? "Enable" : "Disable"}
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {invites.length ? (
            <div className="grid gap-1 text-sm">
              <p className="font-medium">Pending invitations</p>
              <ul className="divide-y divide-border">
                {invites.map((i) => (
                  <li key={i.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                    <span>
                      {i.email} · {i.roleName} {i.expired ? <Badge variant="outline">expired</Badge> : <span className="text-xs text-muted-foreground">until {new Date(i.expiresAt).toLocaleDateString()}</span>}
                    </span>
                    {canManage ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={async () => {
                          const { data, error } = await api.DELETE("/api/admin/invites/{id}", { params: { path: { id: i.id } } });
                          if (data) setInvites(data.items);
                          else fail(error);
                        }}
                      >
                        Revoke
                      </Button>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {canManage ? (
            <div className="grid gap-2 sm:grid-cols-[1fr_1fr_12rem_auto] sm:items-end">
              <div className="grid gap-1">
                <Label htmlFor="inv-email">Invite by email</Label>
                <Input id="inv-email" type="email" value={invite.email} onChange={(e) => setInvite({ ...invite, email: e.target.value })} />
              </div>
              <div className="grid gap-1">
                <Label htmlFor="inv-name">Name (optional)</Label>
                <Input id="inv-name" value={invite.name} onChange={(e) => setInvite({ ...invite, name: e.target.value })} />
              </div>
              <div className="grid gap-1">
                <Label htmlFor="inv-role">Role</Label>
                <Select id="inv-role" value={invite.roleId} onChange={(e) => setInvite({ ...invite, roleId: e.target.value })}>
                  {assignable.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                </Select>
              </div>
              <Button disabled={!invite.email.includes("@")} onClick={() => void sendInvite()}>
                Send invite
              </Button>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
          <CardTitle>Roles</CardTitle>
          {canManage ? (
            <Button size="sm" variant="outline" onClick={() => setEditing("new")}>
              New role
            </Button>
          ) : null}
        </CardHeader>
        <CardContent className="grid gap-3">
          <ul className="divide-y divide-border text-sm">
            {roles.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>
                  <span className="font-medium">{r.name}</span> {r.isSystem ? <Badge variant="outline">built-in</Badge> : null}
                  <span className="block text-xs text-muted-foreground">
                    {r.permissions.includes("*") ? "Everything" : `${r.permissions.length} permissions`} · {r.staffCount} staff
                  </span>
                </span>
                {canManage && r.key !== "owner" ? (
                  <span>
                    <Button size="sm" variant="ghost" onClick={() => setEditing(r)}>
                      Edit
                    </Button>
                    {!r.isSystem ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={async () => {
                          if (!window.confirm(`Delete the ${r.name} role?`)) return;
                          const { data, error } = await api.DELETE("/api/admin/roles/{id}", { params: { path: { id: r.id } } });
                          if (data) setRoles(data.items);
                          else fail(error);
                        }}
                      >
                        Delete
                      </Button>
                    ) : null}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
          {editing ? (
            <RoleEditor
              key={editing === "new" ? "new" : editing.id}
              role={editing === "new" ? null : editing}
              groups={groups}
              onCancel={() => setEditing(null)}
              onSaved={(items, name) => {
                setRoles(items);
                setEditing(null);
                done(`${name} saved`);
              }}
              onError={fail}
            />
          ) : null}
        </CardContent>
      </Card>
    </>
  );
}

function RoleEditor({ role, groups, onCancel, onSaved, onError }: { role: Role | null; groups: Groups; onCancel: () => void; onSaved: (items: Role[], name: string) => void; onError: (e: unknown) => void }) {
  const [name, setName] = useState(role?.name ?? "");
  const [perms, setPerms] = useState<Set<string>>(new Set(role?.permissions ?? []));
  const flip = (p: string) => setPerms((s) => {
    const n = new Set(s);
    if (n.has(p)) n.delete(p);
    else n.add(p);
    return n;
  });
  async function save() {
    const body = { name, permissions: [...perms] as never };
    const res = role ? await api.PUT("/api/admin/roles/{id}", { params: { path: { id: role.id } }, body }) : await api.POST("/api/admin/roles", { body });
    if (res.data) onSaved(res.data.items, name);
    else onError(res.error);
  }
  return (
    <div className="grid gap-4 rounded-md border border-border p-4">
      <div className="grid gap-1 sm:w-72">
        <Label htmlFor="role-name">Role name</Label>
        <Input id="role-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Packer, Support…" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        {groups.map((g) => (
          <fieldset key={g.label} className="grid gap-1.5">
            <legend className="mb-1 text-sm font-medium">{g.label}</legend>
            {g.permissions.map((p) => (
              <label key={p} className="flex items-center gap-2 text-sm">
                <Checkbox checked={perms.has(p)} onChange={() => flip(p)} /> {PERMISSION_LABEL(p)}
              </label>
            ))}
          </fieldset>
        ))}
      </div>
      <div className="flex gap-2">
        <Button disabled={!name.trim()} onClick={() => void save()}>
          Save role
        </Button>
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
