"use client";
import type { Schemas } from "@shopkit/sdk";
import { Alert, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Checkbox, Field, Input, Select } from "@shopkit/ui";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { adminAdapter } from "@/lib/adapters";
import { api, errorMessage } from "@/lib/api-client";
import { ProviderSettings } from "./ProviderSettings";

type Kind = "storage" | "payment" | "email" | "analytics";

export function ProviderSettingsPage({
  kind,
  title,
  description,
  providers,
  credentials,
  settings,
  publicUrl,
  ownerEmail,
}: {
  kind: Kind;
  title: string;
  description: string;
  providers: Schemas["ProviderDescriptor"][];
  credentials: Schemas["CredentialSummary"][];
  settings: Schemas["Settings"];
  publicUrl: string;
  ownerEmail: string;
}) {
  const router = useRouter();
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const saved = credentials.filter((c) => c.kind === kind);
  const activeKey = kind === "storage" ? settings.storage : kind === "email" ? settings.email : null;
  const [active, setActive] = useState(activeKey ? `${activeKey.provider}:${activeKey.mode}` : "");
  const [to, setTo] = useState(ownerEmail);

  async function update(key: "storage.active" | "email.active" | "payments.mode" | "analytics.consentBanner", value: unknown) {
    const { error } = await api.PUT("/api/admin/settings/{key}", { params: { path: { key } }, body: { value } });
    setMsg(error ? { ok: false, text: errorMessage(error) } : { ok: true, text: "Saved." });
    if (!error) router.refresh();
  }

  return (
    <div className="grid gap-6">
      <Card>
        <CardHeader>
          <CardTitle>{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        <CardContent>
          <ProviderSettings kind={kind} providers={providers} credentials={credentials} adapter={adminAdapter} publicUrl={publicUrl} onSaved={() => router.refresh()} />
        </CardContent>
      </Card>
      {(kind === "storage" || kind === "email") && saved.length > 0 ? (
        <Card>
          <CardHeader><CardTitle>Active {kind === "storage" ? "storage" : "email"} provider</CardTitle></CardHeader>
          <CardContent className="grid gap-4">
            <div className="flex items-end gap-2">
              <Field id="active" label="Provider" className="min-w-64">
                <Select id="active" value={active} onChange={(e) => setActive(e.target.value)}>
                  {kind === "email" ? <option value="">None (emails are not sent)</option> : null}
                  {saved.map((c) => <option key={c.id} value={`${c.provider}:${c.mode}`}>{c.provider} ({c.mode})</option>)}
                </Select>
              </Field>
              <Button onClick={() => {
                const [provider, mode] = active.split(":");
                void update(kind === "storage" ? "storage.active" : "email.active", provider ? { provider, mode } : null);
              }}>Use this provider</Button>
            </div>
            {kind === "email" && activeKey ? (
              <div className="flex items-end gap-2">
                <Field id="testTo" label="Send a test email to" className="min-w-64">
                  <Input id="testTo" type="email" value={to} onChange={(e) => setTo(e.target.value)} />
                </Field>
                <Button variant="outline" onClick={async () => {
                  const { data, error } = await api.POST("/api/admin/email/test-send", { body: { provider: activeKey.provider, mode: activeKey.mode, to } });
                  setMsg(data ? { ok: data.ok, text: data.ok ? "Test email sent." : data.error ?? "Failed" } : { ok: false, text: errorMessage(error) });
                }}>Send test email</Button>
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}
      {kind === "payment" ? (
        <Card>
          <CardHeader><CardTitle>Checkout mode</CardTitle></CardHeader>
          <CardContent>
            <Field id="paymentsMode" label="Mode" description="Live mode uses live credentials for real payments.">
              <Select id="paymentsMode" defaultValue={settings.paymentsMode} onChange={(e) => void update("payments.mode", e.target.value)}>
                <option value="test">Test</option>
                <option value="live">Live</option>
              </Select>
            </Field>
          </CardContent>
        </Card>
      ) : null}
      {kind === "analytics" ? (
        <Card>
          <CardContent className="pt-6">
            <label className="flex items-center gap-2 text-sm">
              <Checkbox defaultChecked={settings.consentBanner} onChange={(e) => void update("analytics.consentBanner", e.target.checked)} />
              Show a cookie-consent banner on the storefront
            </label>
          </CardContent>
        </Card>
      ) : null}
      {msg ? <Alert variant={msg.ok ? "success" : "error"}>{msg.text}</Alert> : null}
    </div>
  );
}
