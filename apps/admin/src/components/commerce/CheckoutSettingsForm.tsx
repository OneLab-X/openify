"use client";
import type { Schemas } from "@shopkit/sdk";
import { Alert, Button, Card, CardContent, CardHeader, CardTitle, Checkbox, Input, Label, Select } from "@shopkit/ui";
import { useState } from "react";
import { api, errorMessage } from "@/lib/api-client";

type Cfg = NonNullable<Schemas["Settings"]["checkout"]>;

export function CheckoutSettingsForm({ initial }: { initial: Cfg }) {
  const [cfg, setCfg] = useState(initial);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  async function save() {
    const { error } = await api.PUT("/api/admin/settings/{key}", { params: { path: { key: "checkout.config" } }, body: { value: cfg } });
    setMsg(error ? { ok: false, text: errorMessage(error) } : { ok: true, text: "Checkout settings saved" });
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Checkout</CardTitle>
      </CardHeader>
      <CardContent className="grid max-w-xl gap-4">
        {msg ? <Alert variant={msg.ok ? "success" : "error"}>{msg.text}</Alert> : null}
        <div className="grid gap-1">
          <Label htmlFor="prefix">Order number prefix</Label>
          <Input id="prefix" value={cfg.orderPrefix} maxLength={10} onChange={(e) => setCfg({ ...cfg, orderPrefix: e.target.value })} />
          <p className="text-xs text-muted-foreground">Orders are named {cfg.orderPrefix || ""}1001, {cfg.orderPrefix || ""}1002…</p>
        </div>
        <div className="grid gap-1">
          <Label htmlFor="reserve">Hold stock for unpaid checkouts (minutes)</Label>
          <Input id="reserve" type="number" min={5} max={10080} value={cfg.reservationMinutes} onChange={(e) => setCfg({ ...cfg, reservationMinutes: Number(e.target.value) || 30 })} />
          <p className="text-xs text-muted-foreground">Stock is reserved when the customer starts paying and released if payment doesn&apos;t arrive in time.</p>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={cfg.requirePhone} onChange={(e) => setCfg({ ...cfg, requirePhone: e.target.checked })} /> Require a phone number at checkout
        </label>
        <div className="grid gap-1">
          <Label htmlFor="auth">Customer sign-in</Label>
          <Select id="auth" value={cfg.customerAuth} onChange={(e) => setCfg({ ...cfg, customerAuth: e.target.value as Cfg["customerAuth"] })}>
            <option value="otp">One-time code by email (recommended)</option>
            <option value="password">Password (codes still work)</option>
          </Select>
        </div>
        <Button onClick={() => void save()} className="justify-self-start">
          Save
        </Button>
      </CardContent>
    </Card>
  );
}
