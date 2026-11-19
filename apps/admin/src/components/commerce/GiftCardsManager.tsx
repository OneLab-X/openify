"use client";
import type { Schemas } from "@shopkit/sdk";
import { Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle, Checkbox, Input, Label, Textarea } from "@shopkit/ui";
import { useState } from "react";
import { api, errorMessage } from "@/lib/api-client";
import { formatMoney, fromInput } from "@/lib/money";

type GiftCard = Schemas["GiftCard"];
type Detail = Schemas["GiftCardDetail"];

const STATUS_VARIANT = { active: "success", used: "secondary", expired: "outline", disabled: "outline" } as const;

/** Gift cards: issue (code shown once), search by last characters, balance ledger, adjust, disable. */
export function GiftCardsManager({ initial, currency, canWrite }: { initial: GiftCard[]; currency: string; canWrite: boolean }) {
  const [items, setItems] = useState(initial);
  const [query, setQuery] = useState("");
  const [issued, setIssued] = useState<string | null>(null);
  const [open, setOpen] = useState<Detail | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [form, setForm] = useState({ value: "", recipientEmail: "", note: "", expiresAt: "", notify: true });
  const money = (n: number, c = currency) => formatMoney(n, c);

  async function search(q: string) {
    setQuery(q);
    const { data } = await api.GET("/api/admin/gift-cards", { params: { query: q.trim() ? { query: q.trim() } : {} } });
    if (data) setItems(data.items);
  }
  async function issue() {
    const value = fromInput(form.value, currency);
    if (!value || Number.isNaN(value)) return setMsg({ ok: false, text: "Enter the card value" });
    const { data, error } = await api.POST("/api/admin/gift-cards", {
      body: {
        value,
        ...(form.recipientEmail ? { recipientEmail: form.recipientEmail } : {}),
        ...(form.note ? { note: form.note } : {}),
        ...(form.expiresAt ? { expiresAt: new Date(`${form.expiresAt}T23:59:59`).toISOString() } : {}),
        notify: form.notify,
      },
    });
    if (!data) return setMsg({ ok: false, text: errorMessage(error) });
    setIssued(data.code);
    setItems([data, ...items]);
    setForm({ value: "", recipientEmail: "", note: "", expiresAt: "", notify: true });
    setMsg(null);
  }
  async function show(id: string) {
    const { data, error } = await api.GET("/api/admin/gift-cards/{id}", { params: { path: { id } } });
    if (data) setOpen(data);
    else setMsg({ ok: false, text: errorMessage(error) });
  }

  return (
    <div className="grid gap-6">
      <h1 className="text-2xl font-semibold">Gift cards</h1>
      {msg ? <Alert variant={msg.ok ? "success" : "error"}>{msg.text}</Alert> : null}
      {issued ? (
        <Alert variant="success">
          Gift card issued. Code (shown only once): <strong className="font-mono text-base">{issued}</strong>
        </Alert>
      ) : null}
      {canWrite ? (
        <Card>
          <CardHeader>
            <CardTitle>Issue a gift card</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1">
              <Label htmlFor="gc-value">Value ({currency})</Label>
              <Input id="gc-value" inputMode="decimal" value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })} />
            </div>
            <div className="grid gap-1">
              <Label htmlFor="gc-email">Recipient email (optional)</Label>
              <Input id="gc-email" type="email" value={form.recipientEmail} onChange={(e) => setForm({ ...form, recipientEmail: e.target.value })} />
            </div>
            <div className="grid gap-1">
              <Label htmlFor="gc-exp">Expires (optional)</Label>
              <Input id="gc-exp" type="date" value={form.expiresAt} onChange={(e) => setForm({ ...form, expiresAt: e.target.value })} />
            </div>
            <div className="grid gap-1">
              <Label htmlFor="gc-note">Internal note</Label>
              <Input id="gc-note" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
            </div>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={form.notify} onChange={(e) => setForm({ ...form, notify: e.target.checked })} /> Email the code to the recipient
            </label>
            <Button onClick={() => void issue()}>Issue gift card</Button>
          </CardContent>
        </Card>
      ) : null}
      <div className="grid gap-1 sm:w-72">
        <Label htmlFor="gc-search">Find by code (last 4 characters are enough)</Label>
        <Input id="gc-search" type="search" value={query} onChange={(e) => void search(e.target.value)} />
      </div>
      <Card>
        <CardContent className="overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">Code</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Recipient</th>
                <th className="px-4 py-2 text-right font-medium">Balance</th>
                <th className="px-4 py-2 font-medium">Issued</th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">
                    No gift cards.
                  </td>
                </tr>
              ) : null}
              {items.map((g) => (
                <tr key={g.id} className="border-b border-border last:border-0">
                  <td className="px-4 py-2">
                    <button type="button" className="font-mono font-medium hover:underline" onClick={() => void show(g.id)}>
                      {g.maskedCode}
                    </button>
                  </td>
                  <td className="px-4 py-2">
                    <Badge variant={STATUS_VARIANT[g.status]}>{g.status}</Badge>
                  </td>
                  <td className="px-4 py-2">{g.recipientEmail ?? "—"}</td>
                  <td className="px-4 py-2 text-right">
                    {money(g.balance, g.currency)} <span className="text-muted-foreground">/ {money(g.initialValue, g.currency)}</span>
                  </td>
                  <td className="px-4 py-2">{new Date(g.createdAt).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
      {open ? <GiftCardDetail card={open} canWrite={canWrite} onChange={(d) => {
        setOpen(d);
        setItems(items.map((x) => (x.id === d.id ? d : x)));
      }} onClose={() => setOpen(null)} /> : null}
    </div>
  );
}

function GiftCardDetail({ card, canWrite, onChange, onClose }: { card: Detail; canWrite: boolean; onChange: (d: Detail) => void; onClose: () => void }) {
  const [adjust, setAdjust] = useState("");
  const [note, setNote] = useState(card.note ?? "");
  const [error, setError] = useState<string | null>(null);
  const money = (n: number) => formatMoney(n, card.currency);
  async function patch(body: { disabled?: boolean; note?: string | null; adjustment?: number; adjustmentNote?: string }) {
    const { data, error: err } = await api.PATCH("/api/admin/gift-cards/{id}", { params: { path: { id: card.id } }, body });
    if (data) {
      onChange(data);
      setAdjust("");
      setError(null);
    } else setError(errorMessage(err));
  }
  const minor = adjust.trim() ? (adjust.trim().startsWith("-") ? -(fromInput(adjust.trim().slice(1), card.currency) ?? 0) : fromInput(adjust, card.currency)) : null;
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>
          {card.maskedCode} · {money(card.balance)}
        </CardTitle>
        <Button variant="ghost" size="sm" onClick={onClose}>
          Close
        </Button>
      </CardHeader>
      <CardContent className="grid gap-4">
        {error ? <Alert variant="error">{error}</Alert> : null}
        <ol className="grid gap-1 text-sm">
          {card.transactions.map((t) => (
            <li key={t.id} className="flex justify-between gap-2">
              <span>
                {new Date(t.createdAt).toLocaleString()} · {t.kind}
                {t.note ? ` · ${t.note}` : ""}
              </span>
              <span>
                {t.amount > 0 ? "+" : ""}
                {money(t.amount)} → {money(t.balanceAfter)}
              </span>
            </li>
          ))}
        </ol>
        {canWrite ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="grid gap-1">
              <Label htmlFor="gc-adjust">Adjust balance (use − to deduct)</Label>
              <div className="flex gap-2">
                <Input id="gc-adjust" inputMode="decimal" value={adjust} onChange={(e) => setAdjust(e.target.value)} />
                <Button variant="outline" disabled={!minor || Number.isNaN(minor)} onClick={() => void patch({ adjustment: minor!, adjustmentNote: "Manual adjustment" })}>
                  Apply
                </Button>
              </div>
            </div>
            <div className="grid gap-1">
              <Label htmlFor="gc-note2">Note</Label>
              <Textarea id="gc-note2" rows={2} value={note} onChange={(e) => setNote(e.target.value)} onBlur={() => note !== (card.note ?? "") && void patch({ note: note || null })} />
            </div>
            <Button variant={card.disabledAt ? "outline" : "destructive"} onClick={() => void patch({ disabled: !card.disabledAt })}>
              {card.disabledAt ? "Enable card" : "Disable card"}
            </Button>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
