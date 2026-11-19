"use client";
import type { Schemas } from "@shopkit/sdk";
import { Alert, Button, Card, CardContent, CardHeader, CardTitle, Checkbox, Input, Label, Select, Textarea } from "@shopkit/ui";
import Link from "next/link";
import { useState } from "react";
import { api, errorMessage } from "@/lib/api-client";
import { formatMoney, fromInput, toInput } from "@/lib/money";
import { FinancialBadge, FulfillmentBadge, OrderStatusBadge, human } from "./badges";

type Order = Schemas["OrderAdmin"];
type Panel = "refund" | "cancel" | "shipping" | null;

/**
 * Order page: lines, totals, payments, timeline with staff comments, tags and note, and the
 * actions (mark paid, refund, cancel with restock/refund, shipping update email).
 */
export function OrderDetail({ initial }: { initial: Order }) {
  const [order, setOrder] = useState(initial);
  const [panel, setPanel] = useState<Panel>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const money = (n: number) => formatMoney(n, order.currency);
  const id = order.id;
  const refundable = order.amountPaid - order.amountRefunded;
  const open = order.status !== "cancelled";

  async function act(label: string, fn: () => Promise<{ data?: Order; error?: unknown }>) {
    setBusy(true);
    setMsg(null);
    const { data, error } = await fn();
    setBusy(false);
    if (data) {
      setOrder(data);
      setPanel(null);
      setMsg({ ok: true, text: label });
    } else setMsg({ ok: false, text: errorMessage(error) });
  }

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <Link href="/orders" className="text-sm text-muted-foreground hover:underline">
          ← Orders
        </Link>
        <h1 className="text-2xl font-semibold">{order.name}</h1>
        <FinancialBadge status={order.financialStatus} />
        <FulfillmentBadge status={order.fulfillmentStatus} />
        <OrderStatusBadge status={order.status} />
        {order.paymentMode === "test" ? <span className="rounded bg-warning/20 px-2 py-0.5 text-xs">Test payment</span> : null}
        <span className="text-sm text-muted-foreground">{order.placedAt ? new Date(order.placedAt).toLocaleString() : ""}</span>
      </div>
      <div className="flex flex-wrap gap-2">
        {open && order.amountPaid < order.total ? (
          <Button
            variant="outline"
            loading={busy}
            onClick={() => window.confirm(`Record ${money(order.total - order.amountPaid)} as received?`) && void act("Marked as paid", () => api.POST("/api/admin/orders/{id}/mark-paid", { params: { path: { id } }, body: {} }))}
          >
            Mark as paid
          </Button>
        ) : null}
        {refundable > 0 ? (
          <Button variant="outline" onClick={() => setPanel(panel === "refund" ? null : "refund")}>
            Refund
          </Button>
        ) : null}
        {open ? (
          <Button variant="outline" onClick={() => setPanel(panel === "shipping" ? null : "shipping")}>
            Send shipping update
          </Button>
        ) : null}
        {open && order.fulfillmentStatus === "unfulfilled" ? (
          <Button variant="outline" onClick={() => setPanel(panel === "cancel" ? null : "cancel")}>
            Cancel order
          </Button>
        ) : null}
        <a href={order.statusUrl} target="_blank" rel="noreferrer" className="inline-flex h-10 items-center px-2 text-sm underline">
          Customer status page
        </a>
      </div>
      {msg ? <Alert variant={msg.ok ? "success" : "error"}>{msg.text}</Alert> : null}
      {panel === "refund" ? <RefundPanel order={order} busy={busy} onSubmit={(body) => act("Refund issued", () => api.POST("/api/admin/orders/{id}/refunds", { params: { path: { id } }, body }))} /> : null}
      {panel === "cancel" ? <CancelPanel order={order} busy={busy} onSubmit={(body) => act("Order cancelled", () => api.POST("/api/admin/orders/{id}/cancel", { params: { path: { id } }, body }))} /> : null}
      {panel === "shipping" ? (
        <ShippingPanel busy={busy} onSubmit={(body) => act("Shipping update sent", () => api.POST("/api/admin/orders/{id}/shipping-update", { params: { path: { id } }, body }))} />
      ) : null}

      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <div className="grid content-start gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Items</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4">
              <ul className="divide-y divide-border">
                {order.lines.map((l) => (
                  <li key={l.id} className="flex justify-between gap-4 py-2 text-sm">
                    <span>
                      {l.productId ? (
                        <Link href={`/products/${l.productId}`} className="font-medium hover:underline">
                          {l.title}
                        </Link>
                      ) : (
                        <span className="font-medium">{l.title}</span>
                      )}
                      {l.variantTitle ? <span className="text-muted-foreground"> · {l.variantTitle}</span> : null}
                      {l.sku ? <span className="block text-xs text-muted-foreground">SKU {l.sku}</span> : null}
                      {l.refundedQuantity ? <span className="block text-xs text-muted-foreground">{l.refundedQuantity} refunded</span> : null}
                    </span>
                    <span className="text-right">
                      {money(l.unitPrice)} × {l.quantity}
                      <span className="block font-medium">{money(l.unitPrice * l.quantity)}</span>
                    </span>
                  </li>
                ))}
              </ul>
              <dl className="grid gap-1 text-sm sm:ml-auto sm:w-80">
                <Row label="Subtotal" value={money(order.subtotal)} />
                {order.discountApplications.map((d) => (
                  <Row key={d.title} label={`Discount${d.code ? ` (${d.code.toUpperCase()})` : ` (${d.title})`}`} value={`−${money(d.amount)}`} />
                ))}
                {order.shippingLine ? <Row label={`Shipping (${order.shippingLine.title})`} value={money(order.shippingTotal)} /> : null}
                {order.taxLines.map((t) => (
                  <Row key={`${t.title}${t.rateBps}`} label={`${t.title} ${t.rateBps / 100}%${order.taxesIncluded ? " (included)" : ""}`} value={money(t.amount)} />
                ))}
                <Row label="Total" value={money(order.total)} strong />
                <Row label="Paid" value={money(order.amountPaid)} />
                {order.amountRefunded ? <Row label="Refunded" value={`−${money(order.amountRefunded)}`} /> : null}
              </dl>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Payments</CardTitle>
            </CardHeader>
            <CardContent>
              {order.transactions.length === 0 ? (
                <p className="text-sm text-muted-foreground">No payments yet{order.paymentProvider ? ` (${order.paymentProvider})` : ""}.</p>
              ) : (
                <ul className="grid gap-2 text-sm">
                  {order.transactions.map((t) => (
                    <li key={t.id} className="flex flex-wrap justify-between gap-2">
                      <span>
                        {human(t.kind)} · {t.provider}
                        {t.method ? ` · ${t.method}` : ""} · <span className={t.status === "failure" ? "text-destructive" : ""}>{t.status}</span>
                        {t.errorMessage ? <span className="block text-xs text-destructive">{t.errorMessage}</span> : null}
                        {t.providerReference ? <span className="block text-xs text-muted-foreground">{t.providerReference}</span> : null}
                      </span>
                      <span>{money(t.amount)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Timeline order={order} onChange={setOrder} />
        </div>

        <aside className="grid content-start gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Customer</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-2 text-sm">
              {order.customerId ? (
                <Link href={`/customers/${order.customerId}`} className="font-medium hover:underline">
                  {[order.shippingAddress?.firstName, order.shippingAddress?.lastName].filter(Boolean).join(" ") || order.email}
                </Link>
              ) : null}
              <p>{order.email}</p>
              {order.phone ? <p>{order.phone}</p> : null}
              {order.marketingConsent ? <p className="text-muted-foreground">Accepts marketing</p> : null}
              {order.shippingAddress ? (
                <div>
                  <p className="font-medium">Shipping address</p>
                  <p className="whitespace-pre-line text-muted-foreground">
                    {[
                      [order.shippingAddress.firstName, order.shippingAddress.lastName].filter(Boolean).join(" "),
                      order.shippingAddress.company,
                      order.shippingAddress.line1,
                      order.shippingAddress.line2,
                      [order.shippingAddress.city, order.shippingAddress.province, order.shippingAddress.postalCode].filter(Boolean).join(", "),
                      order.shippingAddress.country,
                      order.shippingAddress.phone,
                    ]
                      .filter(Boolean)
                      .join("\n")}
                  </p>
                </div>
              ) : null}
            </CardContent>
          </Card>
          <MetaCard order={order} onChange={setOrder} />
        </aside>
      </div>
    </div>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={`flex justify-between ${strong ? "border-t border-border pt-1 font-semibold" : ""}`}>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function RefundPanel({ order, busy, onSubmit }: { order: Order; busy: boolean; onSubmit: (b: { amount: number; reason?: string; lines: { orderLineId: string; quantity: number; restock: boolean }[]; notify: boolean }) => void }) {
  const refundable = order.amountPaid - order.amountRefunded;
  const [amount, setAmount] = useState(toInput(refundable, order.currency));
  const [reason, setReason] = useState("");
  const [qty, setQty] = useState<Record<string, number>>({});
  const [restock, setRestock] = useState(true);
  const [notify, setNotify] = useState(true);
  const minor = fromInput(amount, order.currency);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Refund</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        {order.lines.map((l) => (
          <label key={l.id} className="flex items-center justify-between gap-3 text-sm">
            <span>
              {l.title}
              {l.variantTitle ? ` · ${l.variantTitle}` : ""}
            </span>
            <Input
              type="number"
              min={0}
              max={l.quantity - l.refundedQuantity}
              value={qty[l.id] ?? 0}
              onChange={(e) => setQty({ ...qty, [l.id]: Math.max(0, Math.min(l.quantity - l.refundedQuantity, Number(e.target.value) || 0)) })}
              className="w-20"
              aria-label={`Quantity of ${l.title} to refund`}
            />
          </label>
        ))}
        <div className="grid gap-1">
          <Label htmlFor="refund-amount">Amount ({order.currency}), up to {formatMoney(refundable, order.currency)}</Label>
          <Input id="refund-amount" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
        </div>
        <div className="grid gap-1">
          <Label htmlFor="refund-reason">Reason</Label>
          <Input id="refund-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={restock} onChange={(e) => setRestock(e.target.checked)} /> Restock refunded items
        </label>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={notify} onChange={(e) => setNotify(e.target.checked)} /> Email the customer
        </label>
        <Button
          loading={busy}
          disabled={!minor || Number.isNaN(minor) || minor > refundable}
          onClick={() =>
            onSubmit({
              amount: minor!,
              ...(reason ? { reason } : {}),
              lines: Object.entries(qty)
                .filter(([, q]) => q > 0)
                .map(([orderLineId, quantity]) => ({ orderLineId, quantity, restock })),
              notify,
            })
          }
        >
          Refund {minor && !Number.isNaN(minor) ? formatMoney(minor, order.currency) : ""}
        </Button>
      </CardContent>
    </Card>
  );
}

function CancelPanel({ order, busy, onSubmit }: { order: Order; busy: boolean; onSubmit: (b: { reason: "customer" | "inventory" | "fraud" | "declined" | "other"; restock: boolean; refund: boolean; notify: boolean }) => void }) {
  const [reason, setReason] = useState<"customer" | "inventory" | "fraud" | "declined" | "other">("customer");
  const [restock, setRestock] = useState(true);
  const [refund, setRefund] = useState(order.amountPaid > order.amountRefunded);
  const [notify, setNotify] = useState(true);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Cancel order</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div className="grid gap-1">
          <Label htmlFor="cancel-reason">Reason</Label>
          <Select id="cancel-reason" value={reason} onChange={(e) => setReason(e.target.value as typeof reason)}>
            <option value="customer">Customer changed or cancelled order</option>
            <option value="inventory">Items unavailable</option>
            <option value="fraud">Fraudulent order</option>
            <option value="declined">Payment declined</option>
            <option value="other">Other</option>
          </Select>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={restock} onChange={(e) => setRestock(e.target.checked)} /> Restock items
        </label>
        {order.amountPaid > order.amountRefunded ? (
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={refund} onChange={(e) => setRefund(e.target.checked)} /> Refund {formatMoney(order.amountPaid - order.amountRefunded, order.currency)}
          </label>
        ) : null}
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={notify} onChange={(e) => setNotify(e.target.checked)} /> Email the customer
        </label>
        <Button variant="destructive" loading={busy} onClick={() => onSubmit({ reason, restock, refund, notify })}>
          Cancel order
        </Button>
      </CardContent>
    </Card>
  );
}

function ShippingPanel({ busy, onSubmit }: { busy: boolean; onSubmit: (b: { carrier?: string; trackingNumber?: string; trackingUrl?: string; message?: string }) => void }) {
  const [f, setF] = useState({ carrier: "", trackingNumber: "", trackingUrl: "", message: "" });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <Card>
      <CardHeader>
        <CardTitle>Shipping update</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3 sm:grid-cols-2">
        <div className="grid gap-1">
          <Label htmlFor="ship-carrier">Carrier</Label>
          <Input id="ship-carrier" value={f.carrier} onChange={set("carrier")} />
        </div>
        <div className="grid gap-1">
          <Label htmlFor="ship-awb">Tracking number</Label>
          <Input id="ship-awb" value={f.trackingNumber} onChange={set("trackingNumber")} />
        </div>
        <div className="grid gap-1 sm:col-span-2">
          <Label htmlFor="ship-url">Tracking link</Label>
          <Input id="ship-url" type="url" value={f.trackingUrl} onChange={set("trackingUrl")} />
        </div>
        <div className="grid gap-1 sm:col-span-2">
          <Label htmlFor="ship-msg">Message</Label>
          <Textarea id="ship-msg" value={f.message} onChange={set("message")} rows={2} />
        </div>
        <Button loading={busy} onClick={() => onSubmit(Object.fromEntries(Object.entries(f).filter(([, v]) => v.trim())))}>
          Email the customer
        </Button>
      </CardContent>
    </Card>
  );
}

function Timeline({ order, onChange }: { order: Order; onChange: (o: Order) => void }) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  async function post() {
    const { data, error: err } = await api.POST("/api/admin/orders/{id}/comments", { params: { path: { id: order.id } }, body: { message: text } });
    if (data) {
      onChange(data);
      setText("");
    } else setError(errorMessage(err));
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Timeline</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="flex gap-2">
          <Label htmlFor="comment" className="sr-only">
            Add a note to the timeline
          </Label>
          <Input id="comment" value={text} onChange={(e) => setText(e.target.value)} placeholder="Leave a comment (staff only)" />
          <Button variant="outline" disabled={!text.trim()} onClick={() => void post()}>
            Post
          </Button>
        </div>
        {error ? <Alert variant="error">{error}</Alert> : null}
        <ol className="grid gap-3 border-l border-border pl-4 text-sm">
          {order.events.map((e) => (
            <li key={e.id}>
              <p className={e.type === "comment" ? "font-medium" : ""}>{e.message}</p>
              <p className="text-xs text-muted-foreground">
                {new Date(e.createdAt).toLocaleString()} · {e.actorType}
              </p>
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}

function MetaCard({ order, onChange }: { order: Order; onChange: (o: Order) => void }) {
  const [note, setNote] = useState(order.note ?? "");
  const [tags, setTags] = useState(order.tags.join(", "));
  const [saved, setSaved] = useState<string | null>(null);
  async function save() {
    const { data, error } = await api.PATCH("/api/admin/orders/{id}", {
      params: { path: { id: order.id } },
      body: { note, tags: tags.split(",").map((t) => t.trim()).filter(Boolean) },
    });
    if (data) onChange(data);
    setSaved(data ? "Saved" : errorMessage(error));
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Notes and tags</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div className="grid gap-1">
          <Label htmlFor="order-note">Note</Label>
          <Textarea id="order-note" value={note} onChange={(e) => setNote(e.target.value)} rows={3} />
        </div>
        <div className="grid gap-1">
          <Label htmlFor="order-tags">Tags</Label>
          <Input id="order-tags" value={tags} onChange={(e) => setTags(e.target.value)} placeholder="vip, gift" />
        </div>
        <Button variant="outline" onClick={() => void save()}>
          Save
        </Button>
        {saved ? <p className="text-sm text-muted-foreground">{saved}</p> : null}
      </CardContent>
    </Card>
  );
}
