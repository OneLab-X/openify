"use client";
import type { Schemas } from "@shopkit/sdk";
import { Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle, Checkbox, Input, Label, Textarea } from "@shopkit/ui";
import { useState } from "react";
import { api, errorMessage } from "@/lib/api-client";

type Cfg = NonNullable<Schemas["Settings"]["notifications"]>;
type Template = Schemas["NotificationTemplate"];

/** Settings → Notifications: alert recipients, abandoned-checkout delay, and each email's subject + intro. */
export function NotificationsSettings({ config, templates }: { config: Cfg; templates: Template[] }) {
  const [cfg, setCfg] = useState(config);
  const [emails, setEmails] = useState(config.merchantEmails.join(", "));
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  async function save() {
    const value = { ...cfg, merchantEmails: emails.split(",").map((e) => e.trim()).filter(Boolean) };
    const { error } = await api.PUT("/api/admin/settings/{key}", { params: { path: { key: "notifications.config" } }, body: { value } });
    setMsg(error ? { ok: false, text: errorMessage(error) } : { ok: true, text: "Notification settings saved" });
  }
  return (
    <div className="grid gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Notifications</CardTitle>
        </CardHeader>
        <CardContent className="grid max-w-xl gap-4">
          {msg ? <Alert variant={msg.ok ? "success" : "error"}>{msg.text}</Alert> : null}
          <div className="grid gap-1">
            <Label htmlFor="staff-emails">Staff alert recipients</Label>
            <Input id="staff-emails" value={emails} onChange={(e) => setEmails(e.target.value)} placeholder="Leave empty to use the store email" />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={cfg.alertNewOrder} onChange={(e) => setCfg({ ...cfg, alertNewOrder: e.target.checked })} /> Email staff about new orders
          </label>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={cfg.alertPaidOrder} onChange={(e) => setCfg({ ...cfg, alertPaidOrder: e.target.checked })} /> Email staff when a pending order is paid
          </label>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={cfg.abandonedCheckoutEnabled} onChange={(e) => setCfg({ ...cfg, abandonedCheckoutEnabled: e.target.checked })} /> Send abandoned checkout reminders
          </label>
          <div className="grid gap-1">
            <Label htmlFor="abandon-delay">Reminder delay (minutes after the customer leaves)</Label>
            <Input id="abandon-delay" type="number" min={1} max={10080} value={cfg.abandonedCheckoutDelayMinutes} onChange={(e) => setCfg({ ...cfg, abandonedCheckoutDelayMinutes: Number(e.target.value) || 60 })} />
          </div>
          <Button onClick={() => void save()} className="justify-self-start">
            Save
          </Button>
        </CardContent>
      </Card>
      {templates.map((t) => (
        <TemplateCard key={t.id} initial={t} />
      ))}
    </div>
  );
}

function TemplateCard({ initial }: { initial: Template }) {
  const [t, setT] = useState(initial);
  const [msg, setMsg] = useState<string | null>(null);
  async function save() {
    const { data, error } = await api.PUT("/api/admin/notifications/templates/{id}", {
      params: { path: { id: t.id } },
      body: { subject: t.subject, intro: t.intro, enabled: t.enabled },
    });
    if (data) setT(data);
    setMsg(data ? "Saved" : errorMessage(error));
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          {t.title} <Badge variant="outline">{t.audience === "merchant" ? "Staff" : "Customer"}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div className="grid gap-1">
          <Label htmlFor={`${t.id}-subject`}>Subject</Label>
          <Input id={`${t.id}-subject`} value={t.subject} onChange={(e) => setT({ ...t, subject: e.target.value })} />
        </div>
        <div className="grid gap-1">
          <Label htmlFor={`${t.id}-intro`}>Intro text</Label>
          <Textarea id={`${t.id}-intro`} value={t.intro} rows={2} onChange={(e) => setT({ ...t, intro: e.target.value })} />
          <p className="text-xs text-muted-foreground">
            Placeholders: {"{{shop_name}}"}, {"{{order_name}}"}, {"{{customer_name}}"}
            {t.id === "customer_otp" ? `, {{code}}, {{minutes}}` : ""}. Clear a field to restore the default.
          </p>
        </div>
        {t.id !== "customer_otp" ? (
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={t.enabled} onChange={(e) => setT({ ...t, enabled: e.target.checked })} /> Send this email
          </label>
        ) : null}
        <div className="flex items-center gap-3">
          <Button variant="outline" onClick={() => void save()}>
            Save
          </Button>
          {msg ? <span className="text-sm text-muted-foreground">{msg}</span> : null}
        </div>
      </CardContent>
    </Card>
  );
}
