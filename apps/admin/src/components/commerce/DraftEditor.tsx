"use client";
import type { Schemas } from "@shopkit/sdk";
import { Alert, Button, Card, CardContent, CardHeader, CardTitle, Input, Label, Select, Textarea } from "@shopkit/ui";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api, errorMessage, type JsonBody } from "@/lib/api-client";
import { formatMoney, fromInput, toInput } from "@/lib/money";

type Draft = Schemas["DraftOrder"];
type Hit = { variantId: string; productTitle: string; variantTitle: string | null; sku: string | null; price: number; currency: string; available: number | null };
type Line = { variantId: string; quantity: number; label: string };

/** Manual order creation / draft orders: same server pricing as checkout, then "Create order". */
export function DraftEditor({ initial }: { initial: Draft | null }) {
  const router = useRouter();
  const [draft, setDraft] = useState<Draft | null>(initial);
  const currency = draft?.currency ?? "INR";
  const [email, setEmail] = useState(initial?.email ?? "");
  const [phone, setPhone] = useState(initial?.phone ?? "");
  const [lines, setLines] = useState<Line[]>(
    initial?.lines.map((l) => ({ variantId: l.variantId, quantity: l.quantity, label: `${l.title}${l.variantTitle ? ` · ${l.variantTitle}` : ""}` })) ?? [],
  );
  const [shipTitle, setShipTitle] = useState(initial?.shippingLine?.title ?? "");
  const [shipAmount, setShipAmount] = useState(initial?.shippingLine ? toInput(initial.shippingLine.amount, currency) : "");
  const [discountKind, setDiscountKind] = useState<"none" | "percentage" | "fixed_amount">(initial?.discount?.kind ?? "none");
  const [discountValue, setDiscountValue] = useState(
    initial?.discount ? (initial.discount.kind === "percentage" ? String(initial.discount.value / 100) : toInput(initial.discount.value, currency)) : "",
  );
  const [note, setNote] = useState(initial?.note ?? "");
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const completed = draft?.status === "completed";

  useEffect(() => {
    if (q.trim().length < 2) {
      setHits([]);
      return;
    }
    const t = setTimeout(() => {
      void api.GET("/api/admin/variants/search", { params: { query: { q } } }).then(({ data }) => setHits(data?.items ?? []));
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  function body(): JsonBody<"/api/admin/draft-orders", "post"> {
    const ship = fromInput(shipAmount, currency);
    const dv = discountKind === "percentage" ? Math.round(Number(discountValue) * 100) : fromInput(discountValue, currency);
    return {
      email: email.trim() || null,
      phone: phone.trim() || null,
      lines: lines.map(({ variantId, quantity }) => ({ variantId, quantity })),
      shippingLine: shipTitle.trim() && ship !== null && !Number.isNaN(ship) ? { title: shipTitle.trim(), amount: ship } : null,
      discount: discountKind !== "none" && dv && !Number.isNaN(dv) ? { kind: discountKind, value: dv } : null,
      note: note || null,
      tags: [],
    };
  }

  async function save(): Promise<Draft | null> {
    setBusy(true);
    setMsg(null);
    const res = draft ? await api.PUT("/api/admin/draft-orders/{id}", { params: { path: { id: draft.id } }, body: body() }) : await api.POST("/api/admin/draft-orders", { body: body() });
    setBusy(false);
    if (!res.data) {
      setMsg({ ok: false, text: errorMessage(res.error) });
      return null;
    }
    setDraft(res.data);
    if (!draft) router.replace(`/orders/drafts/${res.data.id}`);
    setMsg({ ok: true, text: "Draft saved" });
    return res.data;
  }

  async function complete(paymentPending: boolean) {
    const saved = await save();
    if (!saved) return;
    setBusy(true);
    const { data, error } = await api.POST("/api/admin/draft-orders/{id}/complete", { params: { path: { id: saved.id } }, body: { paymentPending } });
    setBusy(false);
    if (data) router.push(`/orders/${data.orderId}`);
    else setMsg({ ok: false, text: errorMessage(error) });
  }

  return (
    <div className="grid gap-6">
      <div className="flex items-center gap-3">
        <Link href="/orders/drafts" className="text-sm text-muted-foreground hover:underline">
          ← Drafts
        </Link>
        <h1 className="text-2xl font-semibold">{draft ? `Draft ${draft.name}` : "Create order"}</h1>
        {completed && draft?.orderId ? (
          <Link href={`/orders/${draft.orderId}`} className="text-sm underline">
            View order {draft.orderName}
          </Link>
        ) : null}
      </div>
      {msg ? <Alert variant={msg.ok ? "success" : "error"}>{msg.text}</Alert> : null}
      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <div className="grid content-start gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Products</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3">
              <div className="relative">
                <Label htmlFor="variant-search" className="sr-only">
                  Search products
                </Label>
                <Input id="variant-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search products by title or SKU" disabled={completed} />
                {hits.length ? (
                  <ul className="absolute z-10 mt-1 max-h-72 w-full overflow-auto rounded-md border border-border bg-background shadow" role="listbox">
                    {hits.map((h) => (
                      <li key={h.variantId}>
                        <button
                          type="button"
                          className="flex w-full justify-between gap-2 px-3 py-2 text-left text-sm hover:bg-muted"
                          onClick={() => {
                            const label = `${h.productTitle}${h.variantTitle ? ` · ${h.variantTitle}` : ""}`;
                            setLines((ls) => (ls.some((l) => l.variantId === h.variantId) ? ls.map((l) => (l.variantId === h.variantId ? { ...l, quantity: l.quantity + 1 } : l)) : [...ls, { variantId: h.variantId, quantity: 1, label }]));
                            setQ("");
                            setHits([]);
                          }}
                        >
                          <span>
                            {h.productTitle}
                            {h.variantTitle ? <span className="text-muted-foreground"> · {h.variantTitle}</span> : null}
                          </span>
                          <span className="text-muted-foreground">
                            {formatMoney(h.price, h.currency)}
                            {h.available !== null ? ` · ${h.available} in stock` : ""}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </div>
              <ul className="divide-y divide-border">
                {lines.map((l) => (
                  <li key={l.variantId} className="flex items-center justify-between gap-3 py-2 text-sm">
                    <span>{l.label}</span>
                    <span className="flex items-center gap-2">
                      <Input
                        type="number"
                        min={1}
                        value={l.quantity}
                        disabled={completed}
                        onChange={(e) => setLines((ls) => ls.map((x) => (x.variantId === l.variantId ? { ...x, quantity: Math.max(1, Number(e.target.value) || 1) } : x)))}
                        className="w-20"
                        aria-label={`Quantity of ${l.label}`}
                      />
                      <Button variant="ghost" size="sm" disabled={completed} onClick={() => setLines((ls) => ls.filter((x) => x.variantId !== l.variantId))}>
                        Remove
                      </Button>
                    </span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Shipping and discount</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3 sm:grid-cols-2">
              <div className="grid gap-1">
                <Label htmlFor="ship-title">Shipping method</Label>
                <Input id="ship-title" value={shipTitle} onChange={(e) => setShipTitle(e.target.value)} placeholder="e.g. Courier" disabled={completed} />
              </div>
              <div className="grid gap-1">
                <Label htmlFor="ship-amount">Shipping charge ({currency})</Label>
                <Input id="ship-amount" value={shipAmount} onChange={(e) => setShipAmount(e.target.value)} inputMode="decimal" disabled={completed} />
              </div>
              <div className="grid gap-1">
                <Label htmlFor="disc-kind">Discount</Label>
                <Select id="disc-kind" value={discountKind} onChange={(e) => setDiscountKind(e.target.value as typeof discountKind)} disabled={completed}>
                  <option value="none">None</option>
                  <option value="percentage">Percentage</option>
                  <option value="fixed_amount">Fixed amount</option>
                </Select>
              </div>
              {discountKind !== "none" ? (
                <div className="grid gap-1">
                  <Label htmlFor="disc-value">{discountKind === "percentage" ? "Percent off" : `Amount off (${currency})`}</Label>
                  <Input id="disc-value" value={discountValue} onChange={(e) => setDiscountValue(e.target.value)} inputMode="decimal" disabled={completed} />
                </div>
              ) : null}
              <div className="grid gap-1 sm:col-span-2">
                <Label htmlFor="draft-note">Note</Label>
                <Textarea id="draft-note" value={note} onChange={(e) => setNote(e.target.value)} rows={2} disabled={completed} />
              </div>
            </CardContent>
          </Card>
        </div>
        <aside className="grid content-start gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Customer</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3">
              <div className="grid gap-1">
                <Label htmlFor="draft-email">Email</Label>
                <Input id="draft-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} disabled={completed} />
              </div>
              <div className="grid gap-1">
                <Label htmlFor="draft-phone">Phone</Label>
                <Input id="draft-phone" value={phone} onChange={(e) => setPhone(e.target.value)} disabled={completed} />
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Summary</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-2 text-sm">
              {draft ? (
                <dl className="grid gap-1">
                  <div className="flex justify-between">
                    <dt>Subtotal</dt>
                    <dd>{formatMoney(draft.subtotal, currency)}</dd>
                  </div>
                  {draft.discountTotal ? (
                    <div className="flex justify-between">
                      <dt>Discount</dt>
                      <dd>−{formatMoney(draft.discountTotal, currency)}</dd>
                    </div>
                  ) : null}
                  <div className="flex justify-between">
                    <dt>Shipping</dt>
                    <dd>{formatMoney(draft.shippingTotal, currency)}</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt>Tax{draft.taxesIncluded ? " (included)" : ""}</dt>
                    <dd>{formatMoney(draft.taxTotal, currency)}</dd>
                  </div>
                  <div className="flex justify-between border-t border-border pt-1 font-semibold">
                    <dt>Total</dt>
                    <dd>{formatMoney(draft.total, currency)}</dd>
                  </div>
                </dl>
              ) : (
                <p className="text-muted-foreground">Save to calculate totals.</p>
              )}
              {draft?.blockers.length ? <p className="text-destructive">{draft.blockers.join(". ")}</p> : null}
              {!completed ? (
                <div className="grid gap-2 pt-2">
                  <Button variant="outline" loading={busy} onClick={() => void save()}>
                    Save draft
                  </Button>
                  <Button loading={busy} disabled={lines.length === 0 || !email.trim()} onClick={() => void complete(false)}>
                    Create order (paid)
                  </Button>
                  <Button variant="secondary" loading={busy} disabled={lines.length === 0 || !email.trim()} onClick={() => void complete(true)}>
                    Create order (payment pending)
                  </Button>
                </div>
              ) : null}
            </CardContent>
          </Card>
        </aside>
      </div>
    </div>
  );
}
