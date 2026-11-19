"use client";
import type { Schemas } from "@shopkit/sdk";
import { Alert, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Field, Input } from "@shopkit/ui";
import { useState, type FormEvent } from "react";
import { api, errorMessage } from "@/lib/api-client";

export function AcceptInvite({ token, invite }: { token: string; invite: Schemas["StaffInviteInfo"] }) {
  const [name, setName] = useState(invite.name ?? "");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    const { error: err } = await api.POST("/api/admin/auth/invites/{token}/accept", { params: { path: { token } }, body: { name, password } });
    setBusy(false);
    if (err) return setError(errorMessage(err));
    window.location.assign("/admin/login");
  }
  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>Join {invite.storeName}</CardTitle>
        <CardDescription>
          You were invited as {invite.roleName} ({invite.email}). Choose your name and a password.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={(e) => void submit(e)} className="grid gap-4">
          <Field id="inv-name" label="Your name" required>
            <Input id="inv-name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" required />
          </Field>
          <Field id="inv-pw" label="Password" description="At least 12 characters; avoid common words." required>
            <Input id="inv-pw" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" required />
          </Field>
          {error ? <Alert variant="error">{error}</Alert> : null}
          <Button type="submit" loading={busy}>
            Create account
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
