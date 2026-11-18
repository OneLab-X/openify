"use client";
import type { Schemas } from "@shopkit/sdk";
import { Alert, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Checkbox, Field, Input, Select } from "@shopkit/ui";
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from "react";
import { setupAdapter } from "@/lib/adapters";
import { text } from "@/lib/form";
import { api, errorMessage, fieldErrors } from "@/lib/api-client";
import { BrandUpload } from "../BrandUpload";
import { ProviderSettings } from "../ProviderSettings";
import { ShippingTaxForm } from "../ShippingTaxForm";
import { StoreDetailsForm } from "../StoreDetailsForm";

type State = Schemas["WizardState"];
type Step = State["currentStep"];

const STEPS: { id: Step; title: string; optional?: boolean }[] = [
  { id: "owner", title: "Owner account" },
  { id: "storage", title: "Storage" },
  { id: "store", title: "Store details" },
  { id: "payments", title: "Payments", optional: true },
  { id: "email", title: "Email", optional: true },
  { id: "analytics", title: "Analytics", optional: true },
  { id: "shipping_tax", title: "Shipping & tax", optional: true },
  { id: "review", title: "Review & launch" },
];

export function SetupWizard() {
  const [state, setState] = useState<State | null>(null);
  const [needsToken, setNeedsToken] = useState(false);
  const [step, setStep] = useState<Step>("owner");
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(async (moveTo?: Step) => {
    const { data, error, response } = await api.GET("/api/setup/state");
    if (response.status === 401) return setNeedsToken(true);
    if (!data) return setLoadError(errorMessage(error, "Could not load setup state"));
    setNeedsToken(false);
    setState(data);
    setStep(moveTo ?? data.currentStep);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (loadError) return <Alert variant="error">{loadError}</Alert>;
  if (needsToken) return <TokenStep onVerified={() => void refresh()} />;
  if (!state) return <p className="text-sm text-muted-foreground">Loading…</p>;

  const done = new Set(state.completedSteps);
  const next = (s: Step) => void refresh(STEPS[STEPS.findIndex((x) => x.id === s) + 1]?.id ?? "review");

  return (
    <div className="grid gap-8 md:grid-cols-[220px_1fr]">
      <nav aria-label="Setup steps">
        <ol className="grid gap-1">
          {STEPS.map((s, i) => {
            const reachable = done.has(s.id) || s.id === state.currentStep || i <= STEPS.findIndex((x) => x.id === state.currentStep);
            return (
              <li key={s.id}>
                <button
                  type="button"
                  disabled={!reachable}
                  aria-current={s.id === step ? "step" : undefined}
                  onClick={() => setStep(s.id)}
                  className={`flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm ${s.id === step ? "bg-background font-medium shadow-sm" : "text-muted-foreground"} disabled:opacity-50`}
                >
                  <span>{i + 1}. {s.title}</span>
                  {done.has(s.id) ? <span aria-label="done" className="text-success">✓</span> : s.optional ? <span className="text-xs">optional</span> : null}
                </button>
              </li>
            );
          })}
        </ol>
      </nav>
      <section aria-live="polite">
        {step === "owner" && <OwnerStep state={state} onDone={() => next("owner")} />}
        {step === "storage" && (
          <StepCard title="Where should files be stored?" description="Logos and product images are uploaded here. Test connection uploads and deletes a probe file.">
            <ProviderSettings kind="storage" providers={state.providers} credentials={state.credentials} adapter={setupAdapter} requireTestBeforeSave saveLabel="Save" onSaved={() => next("storage")} />
          </StepCard>
        )}
        {step === "store" && <StoreStep state={state} onDone={() => next("store")} />}
        {step === "payments" && <PaymentsStep state={state} onDone={() => next("payments")} refresh={() => refresh("payments")} />}
        {step === "email" && <EmailStep state={state} onDone={() => next("email")} refresh={() => refresh("email")} />}
        {step === "analytics" && <AnalyticsStep state={state} onDone={() => next("analytics")} refresh={() => refresh("analytics")} />}
        {step === "shipping_tax" && (
          <StepCard title="Shipping & tax" description="A starting point. Detailed zones and rates arrive with order management.">
            <ShippingTaxForm
              settings={state.settings}
              shipFrom={state.shipFrom}
              currency={state.store.currency ?? "INR"}
              submitLabel="Save and continue"
              onSubmit={async (body) => {
                const r = await api.PUT("/api/setup/shipping-tax", { body });
                if (!r.error) next("shipping_tax");
                return r;
              }}
            />
            <SkipButton onSkip={async () => {
              const r = await api.PUT("/api/setup/shipping-tax", { body: { skip: true } });
              if (!r.error) next("shipping_tax");
              return r;
            }} />
          </StepCard>
        )}
        {step === "review" && <ReviewStep state={state} />}
      </section>
    </div>
  );
}

function StepCard({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
      </CardHeader>
      <CardContent className="grid gap-6">{children}</CardContent>
    </Card>
  );
}

function SkipButton({ onSkip, label = "Skip for now" }: { onSkip: () => Promise<{ error?: unknown }>; label?: string }) {
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex items-center gap-2">
      <Button variant="ghost" onClick={async () => {
        const r = await onSkip();
        if (r.error) setError(errorMessage(r.error));
      }}>{label}</Button>
      {error ? <span className="text-sm text-destructive">{error}</span> : null}
    </div>
  );
}

function TokenStep({ onVerified }: { onVerified: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const token = text(new FormData(e.currentTarget), "token").trim();
    setBusy(true);
    const { error: err } = await api.POST("/api/setup/token", { body: { token } });
    setBusy(false);
    if (err) setError(errorMessage(err));
    else onVerified();
  }
  return (
    <StepCard title="Enter your setup token" description="This proves you own this server. The token is printed in the API logs.">
      <pre className="overflow-x-auto rounded-md bg-muted px-3 py-2 text-xs">docker compose logs api | grep "setup token"</pre>
      <form onSubmit={(e) => void submit(e)} className="grid gap-4">
        <Field id="token" label="Setup token" error={error ?? undefined} required>
          <Input id="token" name="token" autoComplete="off" spellCheck={false} required />
        </Field>
        <div><Button type="submit" loading={busy}>Continue</Button></div>
      </form>
    </StepCard>
  );
}

function OwnerStep({ state, onDone }: { state: State; onDone: () => void }) {
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [totp, setTotp] = useState<{ secret: string; otpauthUrl: string } | null>(null);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const password = text(f, "password");
    if (password !== text(f, "confirm")) return setErrors({ confirm: "Passwords do not match" });
    setBusy(true);
    setErrors({});
    setMessage(null);
    const { error } = await api.PUT("/api/setup/owner", { body: { name: text(f, "name"), email: text(f, "email"), password } });
    if (error) {
      setBusy(false);
      setErrors(fieldErrors(error));
      return setMessage(errorMessage(error));
    }
    if (f.get("enableTotp") === "on") {
      const { data } = await api.POST("/api/setup/owner/totp/start");
      setBusy(false);
      if (data) return setTotp(data);
    }
    setBusy(false);
    onDone();
  }

  async function confirm(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const code = text(new FormData(e.currentTarget), "code");
    const { error } = await api.POST("/api/setup/owner/totp/confirm", { body: { code } });
    if (error) return setMessage(errorMessage(error));
    onDone();
  }

  if (totp) {
    return (
      <StepCard title="Set up two-factor authentication" description="Add this account to your authenticator app, then enter the 6-digit code.">
        <p className="text-sm">Secret key: <code className="break-all font-mono">{totp.secret}</code></p>
        <a className="text-sm text-primary underline" href={totp.otpauthUrl}>Open in authenticator app</a>
        <form onSubmit={(e) => void confirm(e)} className="grid gap-4">
          <Field id="code" label="Code" error={message ?? undefined}>
            <Input id="code" name="code" inputMode="numeric" pattern="\d{6}" maxLength={6} autoComplete="one-time-code" />
          </Field>
          <div className="flex gap-2"><Button type="submit">Verify and continue</Button><Button variant="ghost" onClick={onDone}>Skip 2FA</Button></div>
        </form>
      </StepCard>
    );
  }

  return (
    <StepCard title="Create the owner account" description="The owner has full access, including payments and staff.">
      <form onSubmit={(e) => void submit(e)} className="grid gap-4" noValidate>
        <Field id="name" label="Your name" required error={errors.name}>
          <Input id="name" name="name" autoComplete="name" defaultValue={state.owner?.name ?? ""} required />
        </Field>
        <Field id="email" label="Email" required error={errors.email}>
          <Input id="email" name="email" type="email" autoComplete="email" defaultValue={state.owner?.email ?? ""} required />
        </Field>
        <Field id="password" label="Password" required description="At least 10 characters; a passphrase works well." error={errors.password}>
          <Input id="password" name="password" type="password" autoComplete="new-password" required />
        </Field>
        <Field id="confirm" label="Confirm password" required error={errors.confirm}>
          <Input id="confirm" name="confirm" type="password" autoComplete="new-password" required />
        </Field>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox name="enableTotp" /> Set up two-factor authentication now
        </label>
        {message && !errors.password ? <Alert variant="error">{message}</Alert> : null}
        <div><Button type="submit" loading={busy}>Save and continue</Button></div>
      </form>
    </StepCard>
  );
}

function StoreStep({ state, onDone }: { state: State; onDone: () => void }) {
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  return (
    <StepCard title="Store details" description="Shown on invoices, emails and your storefront.">
      <div className="grid gap-4 sm:grid-cols-2">
        <BrandUpload asset="logo" url="/api/setup/store/logo" current={state.store.logoUrl} />
        <BrandUpload asset="favicon" url="/api/setup/store/favicon" current={state.store.faviconUrl} />
      </div>
      <StoreDetailsForm
        store={state.store}
        defaultPublicUrl={origin}
        submitLabel="Save and continue"
        onSubmit={async (body) => {
          const r = await api.PUT("/api/setup/store", { body });
          if (!r.error) onDone();
          return r;
        }}
      />
    </StepCard>
  );
}

function PaymentsStep({ state, onDone, refresh }: { state: State; onDone: () => void; refresh: () => Promise<void> }) {
  const [mode, setMode] = useState(state.settings.paymentsMode);
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  return (
    <StepCard title="Payments" description="Add one or more payment methods. Cash on Delivery works without any account.">
      <ProviderSettings kind="payment" providers={state.providers} credentials={state.credentials} adapter={setupAdapter} publicUrl={state.store.publicUrl ?? origin} onSaved={refresh} />
      <Field id="paymentsMode" label="Checkout mode" description="Test mode uses your test keys; switch to live when you are ready to take real orders.">
        <Select id="paymentsMode" value={mode} onChange={(e) => setMode(e.target.value as "test" | "live")}>
          <option value="test">Test</option>
          <option value="live">Live</option>
        </Select>
      </Field>
      <div className="flex gap-2">
        <Button onClick={async () => {
          const r = await api.POST("/api/setup/steps/{step}", { params: { path: { step: "payments" } }, body: { payments: { mode } } });
          if (!r.error) onDone();
        }}>Continue</Button>
        <SkipButton onSkip={async () => {
          const r = await api.POST("/api/setup/steps/{step}", { params: { path: { step: "payments" } }, body: { skip: true } });
          if (!r.error) onDone();
          return r;
        }} />
      </div>
    </StepCard>
  );
}

function EmailStep({ state, onDone, refresh }: { state: State; onDone: () => void; refresh: () => Promise<void> }) {
  const saved = state.credentials.filter((c) => c.kind === "email");
  const [active, setActive] = useState(state.settings.email?.provider ?? saved[0]?.provider ?? "");
  const [to, setTo] = useState(state.owner?.email ?? "");
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const chosen = saved.find((c) => c.provider === active);
  return (
    <StepCard title="Email" description="Used for order confirmations and staff notifications.">
      <ProviderSettings kind="email" providers={state.providers} credentials={state.credentials} adapter={setupAdapter} onSaved={refresh} />
      {saved.length > 0 ? (
        <div className="grid gap-4 rounded-md border border-border p-4">
          <Field id="activeEmail" label="Send email with">
            <Select id="activeEmail" value={active} onChange={(e) => setActive(e.target.value)}>
              {saved.map((c) => <option key={c.provider} value={c.provider}>{c.provider}</option>)}
            </Select>
          </Field>
          <div className="flex flex-wrap items-end gap-2">
            <Field id="testTo" label="Send a test email to" className="min-w-64 flex-1">
              <Input id="testTo" type="email" value={to} onChange={(e) => setTo(e.target.value)} />
            </Field>
            <Button variant="outline" onClick={async () => {
              if (!chosen) return;
              const { data, error: err } = await api.POST("/api/setup/email/test-send", { body: { provider: chosen.provider, mode: chosen.mode, to } });
              setResult(data ? (data.ok ? { ok: true, text: "Test email sent." } : { ok: false, text: data.error ?? "Sending failed" }) : { ok: false, text: errorMessage(err) });
            }}>Send test email</Button>
          </div>
          {result ? <Alert variant={result.ok ? "success" : "error"}>{result.text}</Alert> : null}
        </div>
      ) : null}
      {error ? <Alert variant="error">{error}</Alert> : null}
      <div className="flex gap-2">
        <Button disabled={!chosen} onClick={async () => {
          const r = await api.POST("/api/setup/steps/{step}", { params: { path: { step: "email" } }, body: { email: { provider: chosen!.provider, mode: chosen!.mode } } });
          if (r.error) setError(errorMessage(r.error));
          else onDone();
        }}>Continue</Button>
        <SkipButton onSkip={async () => {
          const r = await api.POST("/api/setup/steps/{step}", { params: { path: { step: "email" } }, body: { skip: true } });
          if (!r.error) onDone();
          return r;
        }} />
      </div>
    </StepCard>
  );
}

function AnalyticsStep({ state, onDone, refresh }: { state: State; onDone: () => void; refresh: () => Promise<void> }) {
  const [consent, setConsent] = useState(state.settings.consentBanner);
  return (
    <StepCard title="Analytics" description="Built-in reports work without any provider. Add one to also send data there.">
      <ProviderSettings kind="analytics" providers={state.providers} credentials={state.credentials} adapter={setupAdapter} onSaved={refresh} />
      <label className="flex items-center gap-2 text-sm">
        <Checkbox checked={consent} onChange={(e) => setConsent(e.target.checked)} /> Show a cookie-consent banner (scripts that need consent load only after it is accepted)
      </label>
      <div className="flex gap-2">
        <Button onClick={async () => {
          const r = await api.POST("/api/setup/steps/{step}", { params: { path: { step: "analytics" } }, body: { analytics: { consentBanner: consent } } });
          if (!r.error) onDone();
        }}>Continue</Button>
        <SkipButton onSkip={async () => {
          const r = await api.POST("/api/setup/steps/{step}", { params: { path: { step: "analytics" } }, body: { skip: true } });
          if (!r.error) onDone();
          return r;
        }} />
      </div>
    </StepCard>
  );
}

function ReviewStep({ state }: { state: State }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const creds = (kind: string) => state.credentials.filter((c) => c.kind === kind).map((c) => `${c.provider} (${c.mode})`).join(", ") || "Not set up";
  const rows: [string, ReactNode][] = [
    ["Owner", state.owner ? `${state.owner.name} <${state.owner.email}>` : "Missing"],
    ["Storage", `${state.settings.storage.provider}`],
    ["Store", state.store.name ? `${state.store.name} · ${state.store.currency ?? ""}` : "Missing"],
    ["Payments", creds("payment")],
    ["Email", state.settings.email ? state.settings.email.provider : "Not set up"],
    ["Analytics", creds("analytics")],
    ["Tax", state.settings.tax.mode === "india_gst" ? "India GST" : "VAT / sales tax"],
  ];
  return (
    <StepCard title="Review & launch" description="Launching creates your store and signs you in.">
      <dl className="grid gap-2 text-sm sm:grid-cols-[160px_1fr]">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-muted-foreground">{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <div className="flex flex-wrap gap-2">
        {state.completedSteps.map((s) => <Badge key={s} variant="success">{s.replace("_", " ")}</Badge>)}
      </div>
      {error ? <Alert variant="error">{error}</Alert> : null}
      <div>
        <Button size="lg" loading={busy} onClick={async () => {
          setBusy(true);
          const { error: err } = await api.POST("/api/setup/launch");
          if (err) {
            setBusy(false);
            return setError(errorMessage(err));
          }
          window.location.assign("/admin");
        }}>Launch store</Button>
      </div>
    </StepCard>
  );
}
