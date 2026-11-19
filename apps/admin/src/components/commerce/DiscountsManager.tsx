"use client";
import type { Schemas } from "@shopkit/sdk";
import { Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle, Checkbox, Input, Label, Select } from "@shopkit/ui";
import { useState } from "react";
import { api, errorMessage } from "@/lib/api-client";
import { formatMoney, fromInput } from "@/lib/money";

type Discount = Schemas["Discount"];

/** Basic discount codes (Phase 3). The full discount engine replaces this page in Phase 4. */
export function DiscountsManager({ initial, currency }: { initial: Discount[]; currency: string }) {
  const [items, setItems] = useState(initial);
  const [form, setForm] = useState({ title: "", code: "", kind: "percentage" as Discount["kind"], value: "", minSubtotal: "", usageLimit: "", endsAt: "", oncePerCustomer: false });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const describe = (d: Discount) => (d.kind === "percentage" ? `${d.value / 100}% off` : d.kind === "fixed_amount" ? `${formatMoney(d.value, currency)} off` : "Free shipping");

  async function create() {
    const value = form.kind === "percentage" ? Math.round(Number(form.value) * 100) : form.kind === "fixed_amount" ? fromInput(form.value, currency) : 0;
    const min = fromInput(form.minSubtotal, currency);
    const { data, error } = await api.POST("/api/admin/discounts", {
      body: {
        title: form.title || form.code,
        code: form.code,
        kind: form.kind,
        value: value ?? 0,
        minSubtotal: min && !Number.isNaN(min) ? min : null,
        usageLimit: form.usageLimit ? Number(form.usageLimit) : null,
        endsAt: form.endsAt ? new Date(form.endsAt).toISOString() : null,
        oncePerCustomer: form.oncePerCustomer,
      },
    });
    if (data) {
      setItems([data, ...items]);
      setMsg({ ok: true, text: `${data.code.toUpperCase()} created` });
      setForm({ ...form, title: "", code: "", value: "" });
    } else setMsg({ ok: false, text: errorMessage(error) });
  }

  async function toggle(d: Discount) {
    const { data, error } = await api.PUT("/api/admin/discounts/{id}", {
      params: { path: { id: d.id } },
      body: { title: d.title, code: d.code, kind: d.kind, value: d.value, minSubtotal: d.minSubtotal, startsAt: d.startsAt, endsAt: d.endsAt, usageLimit: d.usageLimit, oncePerCustomer: d.oncePerCustomer, status: d.status === "active" ? "disabled" : "active" },
    });
    if (data) setItems(items.map((x) => (x.id === d.id ? data : x)));
    else setMsg({ ok: false, text: errorMessage(error) });
  }

  async function remove(d: Discount) {
    if (!window.confirm(`Delete ${d.code.toUpperCase()}?`)) return;
    const { error } = await api.DELETE("/api/admin/discounts/{id}", { params: { path: { id: d.id } } });
    if (error) setMsg({ ok: false, text: errorMessage(error) });
    else setItems(items.filter((x) => x.id !== d.id));
  }

  return (
    <div className="grid gap-6">
      <h1 className="text-2xl font-semibold">Discounts</h1>
      {msg ? <Alert variant={msg.ok ? "success" : "error"}>{msg.text}</Alert> : null}
      <Card>
        <CardHeader>
          <CardTitle>New discount code</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3 sm:grid-cols-3">
          <div className="grid gap-1">
            <Label htmlFor="d-code">Code</Label>
            <Input id="d-code" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="d-kind">Type</Label>
            <Select id="d-kind" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as Discount["kind"] })}>
              <option value="percentage">Percentage</option>
              <option value="fixed_amount">Fixed amount</option>
              <option value="free_shipping">Free shipping</option>
            </Select>
          </div>
          {form.kind !== "free_shipping" ? (
            <div className="grid gap-1">
              <Label htmlFor="d-value">{form.kind === "percentage" ? "Percent off" : `Amount off (${currency})`}</Label>
              <Input id="d-value" value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} inputMode="decimal" />
            </div>
          ) : null}
          <div className="grid gap-1">
            <Label htmlFor="d-min">Minimum subtotal ({currency})</Label>
            <Input id="d-min" value={form.minSubtotal} onChange={(e) => setForm({ ...form, minSubtotal: e.target.value })} inputMode="decimal" />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="d-limit">Total uses</Label>
            <Input id="d-limit" type="number" min={1} value={form.usageLimit} onChange={(e) => setForm({ ...form, usageLimit: e.target.value })} />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="d-ends">Ends</Label>
            <Input id="d-ends" type="datetime-local" value={form.endsAt} onChange={(e) => setForm({ ...form, endsAt: e.target.value })} />
          </div>
          <label className="flex items-center gap-2 text-sm sm:col-span-2">
            <Checkbox checked={form.oncePerCustomer} onChange={(e) => setForm({ ...form, oncePerCustomer: e.target.checked })} /> Once per customer
          </label>
          <Button onClick={() => void create()} disabled={!form.code.trim()}>
            Create code
          </Button>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">Code</th>
                <th className="px-4 py-2 font-medium">Discount</th>
                <th className="px-4 py-2 font-medium">Used</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody>
              {items.map((d) => (
                <tr key={d.id} className="border-b border-border last:border-0">
                  <td className="px-4 py-2 font-medium">{d.code.toUpperCase()}</td>
                  <td className="px-4 py-2">{describe(d)}</td>
                  <td className="px-4 py-2">
                    {d.usageCount}
                    {d.usageLimit ? ` / ${d.usageLimit}` : ""}
                  </td>
                  <td className="px-4 py-2">
                    <Badge variant={d.status === "active" ? "success" : "outline"}>{d.status}</Badge>
                  </td>
                  <td className="px-4 py-2 text-right">
                    <Button variant="ghost" size="sm" onClick={() => void toggle(d)}>
                      {d.status === "active" ? "Disable" : "Enable"}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => void remove(d)}>
                      Delete
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
