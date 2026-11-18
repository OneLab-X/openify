"use client";
import { Alert, Button, Card, CardContent, CardHeader, CardTitle, Field, Input } from "@shopkit/ui";
import { useState, type FormEvent } from "react";
import { text } from "@/lib/form";
import { api, errorMessage } from "@/lib/api-client";

export function LoginForm() {
  const [challenge, setChallenge] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError(null);
    const res = challenge
      ? await api.POST("/api/admin/auth/login/totp", { body: { challenge, code: text(f, "code") } })
      : await api.POST("/api/admin/auth/login", { body: { email: text(f, "email"), password: text(f, "password") } });
    setBusy(false);
    if (res.error || !res.data) return setError(errorMessage(res.error));
    if (res.data.status === "totp_required") return setChallenge(res.data.challenge);
    window.location.assign("/admin");
  }

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>{challenge ? "Two-factor code" : "Sign in to your store"}</CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={(e) => void submit(e)} className="grid gap-4">
          {challenge ? (
            <Field id="code" label="6-digit code from your authenticator app">
              <Input id="code" name="code" inputMode="numeric" maxLength={6} autoComplete="one-time-code" autoFocus required />
            </Field>
          ) : (
            <>
              <Field id="email" label="Email">
                <Input id="email" name="email" type="email" autoComplete="username" required />
              </Field>
              <Field id="password" label="Password">
                <Input id="password" name="password" type="password" autoComplete="current-password" required />
              </Field>
            </>
          )}
          {error ? <Alert variant="error">{error}</Alert> : null}
          <Button type="submit" loading={busy}>{challenge ? "Verify" : "Sign in"}</Button>
        </form>
      </CardContent>
    </Card>
  );
}
