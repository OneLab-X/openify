"use client";
import { Alert, Button, Field, Input } from "@shopkit/ui";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, errorMessage } from "@/lib/api-client";

export function TwoFactor({ enabled }: { enabled: boolean }) {
  const router = useRouter();
  const [pending, setPending] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [value, setValue] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  if (enabled) {
    return (
      <div className="grid gap-4">
        <Alert variant="success">Two-factor authentication is on.</Alert>
        <div className="flex items-end gap-2">
          <Field id="pw" label="Password to turn it off"><Input id="pw" type="password" value={value} onChange={(e) => setValue(e.target.value)} /></Field>
          <Button variant="outline" onClick={async () => {
            const { error } = await api.POST("/api/admin/auth/totp/disable", { body: { password: value } });
            if (error) return setMsg({ ok: false, text: errorMessage(error) });
            router.refresh();
          }}>Turn off</Button>
        </div>
        {msg ? <Alert variant="error">{msg.text}</Alert> : null}
      </div>
    );
  }
  if (pending) {
    return (
      <div className="grid gap-4">
        <p className="text-sm">Secret key: <code className="break-all font-mono">{pending.secret}</code></p>
        <a href={pending.otpauthUrl} className="text-sm text-primary underline">Open in authenticator app</a>
        <div className="flex items-end gap-2">
          <Field id="code" label="6-digit code"><Input id="code" inputMode="numeric" maxLength={6} value={value} onChange={(e) => setValue(e.target.value)} /></Field>
          <Button onClick={async () => {
            const { error } = await api.POST("/api/admin/auth/totp/confirm", { body: { code: value } });
            if (error) return setMsg({ ok: false, text: errorMessage(error) });
            router.refresh();
          }}>Verify</Button>
        </div>
        {msg ? <Alert variant="error">{msg.text}</Alert> : null}
      </div>
    );
  }
  return (
    <Button onClick={async () => {
      const { data } = await api.POST("/api/admin/auth/totp/start");
      if (data) setPending(data);
    }}>Turn on two-factor authentication</Button>
  );
}
