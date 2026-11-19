"use client";
import type { Schemas } from "@shopkit/sdk";
import { Alert, Button, Card, CardContent, CardHeader, CardTitle, Checkbox, Input, Label, Select, Textarea } from "@shopkit/ui";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, errorMessage } from "@/lib/api-client";
import { formatMoney } from "@/lib/money";
import { FinancialBadge, FulfillmentBadge } from "./badges";

type Customer = Schemas["CustomerAdmin"];

/** Customer profile, lifetime value, addresses and order history. */
export function CustomerDetail({ initial }: { initial: Customer | null }) {
  const router = useRouter();
  const [c, setC] = useState(initial);
  const [form, setForm] = useState({
    email: initial?.email ?? "",
    firstName: initial?.firstName ?? "",
    lastName: initial?.lastName ?? "",
    phone: initial?.phone ?? "",
    note: initial?.note ?? "",
    tags: initial?.tags.join(", ") ?? "",
    marketingConsent: initial?.marketingConsent ?? false,
    state: initial?.state ?? ("enabled"),
  });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value });

  async function save() {
    setBusy(true);
    const body = { ...form, tags: form.tags.split(",").map((t) => t.trim()).filter(Boolean) };
    const res = c ? await api.PUT("/api/admin/customers/{id}", { params: { path: { id: c.id } }, body }) : await api.POST("/api/admin/customers", { body });
    setBusy(false);
    if (!res.data) return setMsg({ ok: false, text: errorMessage(res.error) });
    setC(res.data);
    setMsg({ ok: true, text: "Customer saved" });
    if (!c) router.replace(`/customers/${res.data.id}`);
  }

  return (
    <div className="grid gap-6">
      <div className="flex items-center gap-3">
        <Link href="/customers" className="text-sm text-muted-foreground hover:underline">
          ← Customers
        </Link>
        <h1 className="text-2xl font-semibold">{c ? [c.firstName, c.lastName].filter(Boolean).join(" ") || c.email : "Add customer"}</h1>
      </div>
      {msg ? <Alert variant={msg.ok ? "success" : "error"}>{msg.text}</Alert> : null}
      {c ? (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          <Stat label="Amount spent" value={c.currency ? formatMoney(c.totalSpent, c.currency) : "—"} />
          <Stat label="Orders" value={String(c.ordersCount)} />
          <Stat label="Customer since" value={new Date(c.createdAt).toLocaleDateString()} />
        </div>
      ) : null}
      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <div className="grid content-start gap-6">
          {c ? (
            <Card>
              <CardHeader>
                <CardTitle>Orders</CardTitle>
              </CardHeader>
              <CardContent>
                {c.orders.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No orders yet.</p>
                ) : (
                  <ul className="divide-y divide-border text-sm">
                    {c.orders.map((o) => (
                      <li key={o.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                        <Link href={`/orders/${o.id}`} className="font-medium hover:underline">
                          {o.name}
                        </Link>
                        <span className="text-muted-foreground">{new Date(o.placedAt).toLocaleDateString()}</span>
                        <FinancialBadge status={o.financialStatus} />
                        <FulfillmentBadge status={o.fulfillmentStatus} />
                        <span>{formatMoney(o.total, o.currency)}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
          ) : null}
          <Card>
            <CardHeader>
              <CardTitle>Details</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3 sm:grid-cols-2">
              <div className="grid gap-1 sm:col-span-2">
                <Label htmlFor="c-email">Email</Label>
                <Input id="c-email" type="email" value={form.email} onChange={set("email")} />
              </div>
              <div className="grid gap-1">
                <Label htmlFor="c-first">First name</Label>
                <Input id="c-first" value={form.firstName} onChange={set("firstName")} />
              </div>
              <div className="grid gap-1">
                <Label htmlFor="c-last">Last name</Label>
                <Input id="c-last" value={form.lastName} onChange={set("lastName")} />
              </div>
              <div className="grid gap-1">
                <Label htmlFor="c-phone">Phone</Label>
                <Input id="c-phone" value={form.phone} onChange={set("phone")} />
              </div>
              <div className="grid gap-1">
                <Label htmlFor="c-state">Account</Label>
                <Select id="c-state" value={form.state} onChange={(e) => setForm({ ...form, state: e.target.value as "enabled" | "disabled" })}>
                  <option value="enabled">Enabled</option>
                  <option value="disabled">Disabled</option>
                </Select>
              </div>
              <div className="grid gap-1 sm:col-span-2">
                <Label htmlFor="c-tags">Tags</Label>
                <Input id="c-tags" value={form.tags} onChange={set("tags")} placeholder="vip, wholesale" />
              </div>
              <div className="grid gap-1 sm:col-span-2">
                <Label htmlFor="c-note">Note</Label>
                <Textarea id="c-note" value={form.note} onChange={set("note")} rows={3} />
              </div>
              <label className="flex items-center gap-2 text-sm sm:col-span-2">
                <Checkbox checked={form.marketingConsent} onChange={(e) => setForm({ ...form, marketingConsent: e.target.checked })} /> Customer agreed to receive marketing emails
              </label>
              <Button loading={busy} onClick={() => void save()} className="justify-self-start">
                Save
              </Button>
            </CardContent>
          </Card>
        </div>
        <aside className="grid content-start gap-6">
          {c ? (
            <Card>
              <CardHeader>
                <CardTitle>Addresses</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-3 text-sm">
                {c.addresses.length === 0 ? <p className="text-muted-foreground">No addresses.</p> : null}
                {c.addresses.map((a) => (
                  <div key={a.id}>
                    <p className="whitespace-pre-line">
                      {[[a.firstName, a.lastName].filter(Boolean).join(" "), a.line1, a.line2, [a.city, a.province, a.postalCode].filter(Boolean).join(", "), a.country, a.phone].filter(Boolean).join("\n")}
                    </p>
                    {a.isDefault ? <p className="text-xs text-muted-foreground">Default</p> : null}
                  </div>
                ))}
              </CardContent>
            </Card>
          ) : null}
        </aside>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardContent className="py-4">
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="text-lg font-semibold">{value}</p>
      </CardContent>
    </Card>
  );
}
