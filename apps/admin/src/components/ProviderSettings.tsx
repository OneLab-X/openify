"use client";
import type { Schemas } from "@shopkit/sdk";
import { Alert, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Field, Select } from "@shopkit/ui";
import { useMemo, useState } from "react";
import { errorMessage, fieldErrors } from "@/lib/api-client";
import { SchemaFields, type Values } from "./ProviderForm";

type Descriptor = Schemas["ProviderDescriptor"];
type Credential = Schemas["CredentialSummary"];
type Mode = "test" | "live";
type Kind = Descriptor["kind"];
export type TestResult = Schemas["TestResult"];

interface Body {
  config: Values;
  secrets: Values;
  enabled: boolean;
}

/** Talks to either the setup API or the admin API; the UI is the same. */
export interface CredentialAdapter {
  test(kind: Kind, provider: string, mode: Mode, body: Body): Promise<{ data?: TestResult; error?: unknown }>;
  save(kind: Kind, provider: string, mode: Mode, body: Body): Promise<{ data?: Credential; error?: unknown }>;
  remove?(kind: Kind, provider: string, mode: Mode): Promise<{ error?: unknown }>;
}

const KIND_LABEL: Record<Kind, string> = {
  storage: "Storage",
  payment: "Payments",
  email: "Email",
  analytics: "Analytics",
  shipping: "Shipping",
};

export function ProviderSettings({
  kind,
  providers,
  credentials,
  adapter,
  onSaved,
  publicUrl,
  saveLabel = "Save",
  requireTestBeforeSave = false,
}: {
  kind: Kind;
  providers: Descriptor[];
  credentials: Credential[];
  adapter: CredentialAdapter;
  onSaved?: (c: Credential) => void | Promise<void>;
  publicUrl?: string;
  saveLabel?: string;
  requireTestBeforeSave?: boolean;
}) {
  const options = providers.filter((p) => p.kind === kind);
  const available = options.filter((p) => p.status === "available");
  const firstSaved = credentials.find((c) => c.kind === kind);
  const [providerId, setProviderId] = useState(firstSaved?.provider ?? available[0]?.id ?? "");
  const descriptor = available.find((p) => p.id === providerId);
  const [mode, setMode] = useState<Mode>((firstSaved?.mode) ?? (descriptor?.modes[0]) ?? "live");
  const saved = credentials.find((c) => c.kind === kind && c.provider === providerId && c.mode === mode);
  const [config, setConfig] = useState<Values>(saved?.config ?? {});
  const [secrets, setSecrets] = useState<Values>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{ variant: "success" | "error" | "info"; text: string } | null>(null);
  const [busy, setBusy] = useState<"test" | "save" | "delete" | null>(null);

  const modes = useMemo(() => (descriptor?.modes ?? []) as Mode[], [descriptor]);

  function choose(id: string, nextMode?: Mode) {
    const d = available.find((p) => p.id === id);
    const m = nextMode ?? (credentials.find((c) => c.provider === id)?.mode) ?? ((d?.modes[0]) ?? "live");
    setProviderId(id);
    setMode(m);
    setConfig(credentials.find((c) => c.provider === id && c.mode === m)?.config ?? {});
    setSecrets({});
    setErrors({});
    setMessage(null);
  }

  const body = (): Body => ({ config, secrets, enabled: true });

  async function test() {
    setBusy("test");
    setMessage(null);
    const { data, error } = await adapter.test(kind, providerId, mode, body());
    setBusy(null);
    if (error || !data) return setMessage({ variant: "error", text: errorMessage(error) });
    setMessage(data.ok ? { variant: "success", text: `Connection works${data.message ? `: ${data.message}` : "."}` } : { variant: "error", text: `Connection failed: ${data.error ?? "unknown error"}` });
  }

  async function save() {
    setBusy("save");
    setMessage(null);
    setErrors({});
    const { data, error } = await adapter.save(kind, providerId, mode, body());
    setBusy(null);
    if (error || !data) {
      setErrors(fieldErrors(error));
      return setMessage({ variant: "error", text: errorMessage(error) });
    }
    setSecrets({});
    setMessage({ variant: "success", text: `${descriptor?.displayName ?? providerId} saved.` });
    await onSaved?.(data);
  }

  async function remove() {
    if (!adapter.remove || !window.confirm(`Remove ${descriptor?.displayName} (${mode}) credentials?`)) return;
    setBusy("delete");
    const { error } = await adapter.remove(kind, providerId, mode);
    setBusy(null);
    setMessage(error ? { variant: "error", text: errorMessage(error) } : { variant: "success", text: "Removed. Reload to refresh the list." });
  }

  return (
    <div className="grid gap-6">
      <fieldset className="grid gap-2">
        <legend className="mb-2 text-sm font-medium">{KIND_LABEL[kind]} provider</legend>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {options.map((p) => {
            const isSaved = credentials.some((c) => c.provider === p.id);
            const soon = p.status === "coming_soon";
            return (
              <label
                key={p.id}
                className={`flex cursor-pointer items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm ${providerId === p.id ? "border-primary ring-1 ring-primary" : "border-border"} ${soon ? "cursor-not-allowed opacity-60" : ""}`}
              >
                <span className="flex items-center gap-2">
                  <input type="radio" name={`${kind}-provider`} value={p.id} checked={providerId === p.id} disabled={soon} onChange={() => choose(p.id)} />
                  {p.displayName}
                </span>
                {soon ? <Badge variant="outline">Coming soon</Badge> : isSaved ? <Badge variant="success">Saved</Badge> : null}
              </label>
            );
          })}
        </div>
      </fieldset>

      {descriptor ? (
        <Card>
          <CardHeader>
            <CardTitle>{descriptor.displayName}</CardTitle>
            {descriptor.description ? <CardDescription>{descriptor.description}</CardDescription> : null}
            {descriptor.docsUrl ? (
              <a className="text-sm text-primary underline" href={descriptor.docsUrl} target="_blank" rel="noreferrer">
                Where do I find these?
              </a>
            ) : null}
          </CardHeader>
          <CardContent className="grid gap-4">
            {modes.length > 1 ? (
              <Field id={`${kind}-mode`} label="Mode">
                <Select id={`${kind}-mode`} value={mode} onChange={(e) => choose(providerId, e.target.value as Mode)}>
                  {modes.map((m) => (
                    <option key={m} value={m}>{m === "test" ? "Test" : "Live"}</option>
                  ))}
                </Select>
              </Field>
            ) : null}
            <SchemaFields idPrefix={`${kind}-${providerId}-config`} schema={descriptor.configSchema} values={config} onChange={setConfig} errors={errors} errorPrefix="config" />
            <SchemaFields
              idPrefix={`${kind}-${providerId}-secret`}
              schema={descriptor.secretsSchema}
              values={secrets}
              onChange={setSecrets}
              secret
              savedSecretFields={saved?.secretFields ?? []}
              last4={saved?.last4 ?? null}
              errors={errors}
              errorPrefix="secrets"
            />
            {kind === "payment" && descriptor.webhookEvents.length > 0 && publicUrl ? (
              <Alert>
                <p className="font-medium">Webhook</p>
                <p>
                  URL: <code className="break-all">{`${publicUrl}/api/webhooks/payments/${descriptor.id}`}</code>
                </p>
                <p>Events: {descriptor.webhookEvents.join(", ")}</p>
              </Alert>
            ) : null}
            {message ? <Alert variant={message.variant}>{message.text}</Alert> : null}
          </CardContent>
          <div className="flex flex-wrap items-center gap-2 p-6 pt-0">
            <Button variant="outline" onClick={() => void test()} loading={busy === "test"}>
              Test connection
            </Button>
            <Button onClick={() => void save()} loading={busy === "save"}>
              {requireTestBeforeSave ? `Test & ${saveLabel.toLowerCase()}` : saveLabel}
            </Button>
            {adapter.remove && saved ? (
              <Button variant="ghost" className="text-destructive" onClick={() => void remove()} loading={busy === "delete"}>
                Remove
              </Button>
            ) : null}
          </div>
        </Card>
      ) : null}
    </div>
  );
}
