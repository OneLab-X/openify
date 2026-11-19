"use client";
import type { Schemas } from "@shopkit/sdk";
import { Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle, Checkbox, Input, Label, Select, Textarea } from "@shopkit/ui";
import { useEffect, useState } from "react";
import { api, errorMessage, type JsonBody } from "@/lib/api-client";
import { formatMoney, fromInput, toInput } from "@/lib/money";
import { printLabel } from "@/lib/print-label";
import { human } from "./badges";

type Order = Schemas["OrderAdmin"];
type Fulfillment = Schemas["Fulfillment"];
type Return = Schemas["Return"];
type Result = Promise<{ data?: Order; error?: unknown }>;
export type Act = (label: string, fn: () => Result) => Promise<void>;

type FulfillBody = JsonBody<"/api/admin/orders/{id}/fulfillments", "post">;
type Method = NonNullable<FulfillBody["method"]>;

const METHOD_LABEL: Record<Method, string> = {
  courier: "Courier with AWB",
  other_courier: "Other courier",
  local_driver: "Local driver (bike / car)",
  carrier: "Shipping app (book shipment)",
  pickup: "Customer pickup",
  none: "No shipping needed",
};

function useCouriers() {
  const [data, setData] = useState<Schemas["Couriers"] | null>(null);
  const [locations, setLocations] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    void api.GET("/api/admin/couriers").then((r) => r.data && setData(r.data));
    void api.GET("/api/admin/locations").then((r) => r.data && setLocations(r.data.filter((l) => l.active)));
  }, []);
  return { couriers: data?.couriers ?? [], carriers: data?.carriers ?? [], locations };
}

/** Fulfil some or all remaining units (PLS DeliveryDialog: local driver, courier AWB, other courier). */
export function FulfillPanel({ order, busy, act }: { order: Order; busy: boolean; act: Act }) {
  const { couriers, carriers, locations } = useCouriers();
  const open = order.lines.filter((l) => l.fulfillableQuantity > 0);
  const [qty, setQty] = useState<Record<string, number>>(Object.fromEntries(open.map((l) => [l.id, l.fulfillableQuantity])));
  const [method, setMethod] = useState<Method>("courier");
  const [f, setF] = useState({ carrier: "", trackingNumber: "", trackingUrl: "", driverName: "", driverMobile: "", tripLink: "", provider: "", locationId: "" });
  const [notify, setNotify] = useState(true);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const lines = Object.entries(qty).filter(([, q]) => q > 0).map(([orderLineId, quantity]) => ({ orderLineId, quantity }));

  function submit() {
    const body: FulfillBody = {
      method,
      lines,
      notifyCustomer: notify,
      ...(f.locationId ? { locationId: f.locationId } : {}),
      ...(method === "courier" || method === "other_courier" ? { carrier: f.carrier, trackingNumber: f.trackingNumber, ...(f.trackingUrl ? { trackingUrl: f.trackingUrl } : {}) } : {}),
      ...(method === "local_driver" ? { driverName: f.driverName, driverMobile: f.driverMobile, ...(f.tripLink ? { tripLink: f.tripLink } : {}) } : {}),
      ...(method === "carrier" ? { provider: f.provider || carriers[0]?.id || "" } : {}),
    };
    void act("Items fulfilled", () => api.POST("/api/admin/orders/{id}/fulfillments", { params: { path: { id: order.id } }, body }));
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Fulfil items</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        <fieldset className="grid gap-2">
          <legend className="mb-1 text-sm font-medium">Items to ship</legend>
          {open.map((l) => (
            <label key={l.id} className="flex items-center justify-between gap-3 text-sm">
              <span>
                {l.title}
                {l.variantTitle ? ` · ${l.variantTitle}` : ""} <span className="text-muted-foreground">({l.fulfillableQuantity} to ship)</span>
              </span>
              <Input
                type="number"
                min={0}
                max={l.fulfillableQuantity}
                className="w-20"
                value={qty[l.id] ?? 0}
                aria-label={`Quantity of ${l.title} to ship`}
                onChange={(e) => setQty({ ...qty, [l.id]: Math.max(0, Math.min(l.fulfillableQuantity, Number(e.target.value) || 0)) })}
              />
            </label>
          ))}
        </fieldset>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1">
            <Label htmlFor="ff-method">Shipping method</Label>
            <Select id="ff-method" value={method} onChange={(e) => setMethod(e.target.value as Method)}>
              {(Object.keys(METHOD_LABEL) as Method[])
                .filter((m) => m !== "carrier" || carriers.length > 0)
                .map((m) => (
                  <option key={m} value={m}>
                    {METHOD_LABEL[m]}
                  </option>
                ))}
            </Select>
          </div>
          {locations.length > 1 ? (
            <div className="grid gap-1">
              <Label htmlFor="ff-location">Ship from</Label>
              <Select id="ff-location" value={f.locationId} onChange={set("locationId")}>
                <option value="">Default location</option>
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </Select>
            </div>
          ) : null}
          {method === "courier" ? (
            <div className="grid gap-1">
              <Label htmlFor="ff-courier">Courier</Label>
              <Select id="ff-courier" value={f.carrier} onChange={set("carrier")}>
                <option value="">Choose…</option>
                {couriers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </div>
          ) : null}
          {method === "other_courier" ? (
            <div className="grid gap-1">
              <Label htmlFor="ff-courier-name">Courier name</Label>
              <Input id="ff-courier-name" value={f.carrier} onChange={set("carrier")} />
            </div>
          ) : null}
          {method === "courier" || method === "other_courier" ? (
            <>
              <div className="grid gap-1">
                <Label htmlFor="ff-awb">AWB / tracking number</Label>
                <Input id="ff-awb" value={f.trackingNumber} onChange={set("trackingNumber")} autoComplete="off" />
              </div>
              <div className="grid gap-1 sm:col-span-2">
                <Label htmlFor="ff-url">Tracking link {method === "courier" ? "(optional, built automatically)" : ""}</Label>
                <Input id="ff-url" type="url" value={f.trackingUrl} onChange={set("trackingUrl")} />
              </div>
            </>
          ) : null}
          {method === "local_driver" ? (
            <>
              <div className="grid gap-1">
                <Label htmlFor="ff-driver">Driver name</Label>
                <Input id="ff-driver" value={f.driverName} onChange={set("driverName")} />
              </div>
              <div className="grid gap-1">
                <Label htmlFor="ff-mobile">Driver mobile</Label>
                <Input id="ff-mobile" type="tel" value={f.driverMobile} onChange={set("driverMobile")} />
              </div>
              <div className="grid gap-1 sm:col-span-2">
                <Label htmlFor="ff-trip">Live trip link (optional)</Label>
                <Input id="ff-trip" type="url" value={f.tripLink} onChange={set("tripLink")} placeholder="https://…" />
              </div>
            </>
          ) : null}
          {method === "carrier" ? (
            <div className="grid gap-1">
              <Label htmlFor="ff-provider">Shipping app</Label>
              <Select id="ff-provider" value={f.provider || carriers[0]?.id || ""} onChange={set("provider")}>
                {carriers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.displayName}
                  </option>
                ))}
              </Select>
            </div>
          ) : null}
        </div>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={notify} onChange={(e) => setNotify(e.target.checked)} /> Email shipping details to the customer
        </label>
        <Button loading={busy} disabled={lines.length === 0} onClick={submit}>
          Fulfil {lines.reduce((n, l) => n + l.quantity, 0)} item(s)
        </Button>
      </CardContent>
    </Card>
  );
}

const STATUS_VARIANT: Record<string, "success" | "warning" | "secondary" | "outline"> = {
  delivered: "success",
  failed: "warning",
  cancelled: "outline",
};

/** Shipped packages with tracking, WhatsApp, labels, status changes and cancellation. */
export function FulfillmentsCard({ order, busy, act }: { order: Order; busy: boolean; act: Act }) {
  const [msg, setMsg] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  if (order.fulfillments.length === 0) return null;
  const lineTitle = (id: string) => order.lines.find((l) => l.id === id)?.title ?? "Item";

  async function whatsapp(f: Fulfillment) {
    const win = window.open("", "_blank");
    const { data, error } = await api.POST("/api/admin/orders/{id}/fulfillments/{fulfillmentId}/whatsapp", { params: { path: { id: order.id, fulfillmentId: f.id } } });
    if (data) {
      if (win) win.location.href = data.url;
      else window.location.assign(data.url);
    } else {
      win?.close();
      setMsg(errorMessage(error));
    }
  }
  async function carrierLabel(f: Fulfillment) {
    const { data, error } = await api.GET("/api/admin/orders/{id}/fulfillments/{fulfillmentId}/label", { params: { path: { id: order.id, fulfillmentId: f.id } } });
    if (data?.url) window.open(data.url, "_blank", "noopener");
    else setMsg(data ? "The carrier has no label for this shipment yet" : errorMessage(error));
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Fulfillments</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        {msg ? <Alert variant="error">{msg}</Alert> : null}
        {order.fulfillments.map((f) => (
          <div key={f.id} className="grid gap-2 rounded-md border border-border p-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{f.name}</span>
              <Badge variant={STATUS_VARIANT[f.status] ?? "secondary"}>{human(f.status)}</Badge>
              <span className="text-muted-foreground">{new Date(f.createdAt).toLocaleString()}</span>
            </div>
            <ul className="text-muted-foreground">
              {f.lines.map((l) => (
                <li key={l.orderLineId}>
                  {lineTitle(l.orderLineId)} × {l.quantity}
                </li>
              ))}
            </ul>
            <ul>
              {f.deliveryLines.map((d) => (
                <li key={d} className="whitespace-pre-line">
                  {d}
                </li>
              ))}
            </ul>
            {f.trackingUrl ? (
              <a className="text-primary underline" href={f.trackingUrl} target="_blank" rel="noreferrer">
                Track package
              </a>
            ) : null}
            {f.status !== "cancelled" ? (
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={() => void whatsapp(f)}>
                  {f.whatsappSentAt ? "WhatsApp again" : "Send on WhatsApp"}
                </Button>
                <Button size="sm" variant="outline" onClick={() => printLabel(order, f, "A6")}>
                  Print label (A6)
                </Button>
                <Button size="sm" variant="outline" onClick={() => printLabel(order, f, "A4")}>
                  Print label (A4)
                </Button>
                {f.provider ? (
                  <Button size="sm" variant="outline" onClick={() => void carrierLabel(f)}>
                    Carrier label
                  </Button>
                ) : null}
                {f.status !== "delivered" ? (
                  <>
                    <Button size="sm" variant="outline" onClick={() => setEditing(editing === f.id ? null : f.id)}>
                      Update tracking
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      loading={busy}
                      onClick={() =>
                        void act("Marked as delivered", () =>
                          api.PATCH("/api/admin/orders/{id}/fulfillments/{fulfillmentId}", { params: { path: { id: order.id, fulfillmentId: f.id } }, body: { status: "delivered", notifyCustomer: f.notifyCustomer } }),
                        )
                      }
                    >
                      Mark delivered
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        window.confirm(`Cancel ${f.name}? Its items go back to “to fulfil”.`) &&
                        void act("Fulfillment cancelled", () => api.POST("/api/admin/orders/{id}/fulfillments/{fulfillmentId}/cancel", { params: { path: { id: order.id, fulfillmentId: f.id } } }))
                      }
                    >
                      Cancel
                    </Button>
                  </>
                ) : null}
              </div>
            ) : null}
            {editing === f.id ? <TrackingForm order={order} f={f} busy={busy} act={act} onDone={() => setEditing(null)} /> : null}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function TrackingForm({ order, f, busy, act, onDone }: { order: Order; f: Fulfillment; busy: boolean; act: Act; onDone: () => void }) {
  const [t, setT] = useState({ trackingNumber: f.trackingNumber ?? "", trackingUrl: f.trackingUrl ?? "", status: f.status === "cancelled" ? "shipped" : f.status, notify: false });
  return (
    <div className="grid gap-2 border-t border-border pt-3 sm:grid-cols-2">
      <div className="grid gap-1">
        <Label htmlFor={`t-awb-${f.id}`}>Tracking number</Label>
        <Input id={`t-awb-${f.id}`} value={t.trackingNumber} onChange={(e) => setT({ ...t, trackingNumber: e.target.value })} />
      </div>
      <div className="grid gap-1">
        <Label htmlFor={`t-status-${f.id}`}>Status</Label>
        <Select id={`t-status-${f.id}`} value={t.status} onChange={(e) => setT({ ...t, status: e.target.value as typeof t.status })}>
          {(["pending", "shipped", "in_transit", "out_for_delivery", "delivered", "failed"] as const).map((s) => (
            <option key={s} value={s}>
              {human(s)}
            </option>
          ))}
        </Select>
      </div>
      <div className="grid gap-1 sm:col-span-2">
        <Label htmlFor={`t-url-${f.id}`}>Tracking link</Label>
        <Input id={`t-url-${f.id}`} type="url" value={t.trackingUrl} onChange={(e) => setT({ ...t, trackingUrl: e.target.value })} />
      </div>
      <label className="flex items-center gap-2 text-sm sm:col-span-2">
        <Checkbox checked={t.notify} onChange={(e) => setT({ ...t, notify: e.target.checked })} /> Email the customer
      </label>
      <Button
        size="sm"
        loading={busy}
        onClick={() =>
          void act("Tracking updated", () =>
            api.PATCH("/api/admin/orders/{id}/fulfillments/{fulfillmentId}", {
              params: { path: { id: order.id, fulfillmentId: f.id } },
              body: { trackingNumber: t.trackingNumber, trackingUrl: t.trackingUrl, status: t.status as "shipped", notifyCustomer: t.notify },
            }),
          ).then(onDone)
        }
      >
        Save
      </Button>
    </div>
  );
}

/** Refund by line and/or amount, with restock and shipping; the server suggests the amount. */
export function RefundPanel({ order, busy, act }: { order: Order; busy: boolean; act: Act }) {
  const refundable = order.amountPaid - order.amountRefunded;
  const [qty, setQty] = useState<Record<string, number>>({});
  const [restock, setRestock] = useState(true);
  const [fullShipping, setFullShipping] = useState(false);
  const [amount, setAmount] = useState("");
  const [touched, setTouched] = useState(false);
  const [calc, setCalc] = useState<Schemas["RefundCalculation"] | null>(null);
  const [reason, setReason] = useState("");
  const [notify, setNotify] = useState(true);
  const lines = Object.entries(qty).filter(([, q]) => q > 0).map(([orderLineId, quantity]) => ({ orderLineId, quantity, restock }));
  const key = JSON.stringify([lines, fullShipping]);

  useEffect(() => {
    let live = true;
    void api.POST("/api/admin/orders/{id}/refunds/calculate", { params: { path: { id: order.id } }, body: { lines, fullShipping } }).then(({ data }) => {
      if (!live || !data) return;
      setCalc(data);
      if (!touched) setAmount(toInput(lines.length || fullShipping ? data.suggested : data.refundable, order.currency));
    });
    return () => {
      live = false;
    };
  }, [key]);

  const minor = fromInput(amount, order.currency);
  const money = (n: number) => formatMoney(n, order.currency);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Refund</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        {order.lines.map((l) => {
          const max = l.quantity - l.refundedQuantity;
          return max > 0 ? (
            <label key={l.id} className="flex items-center justify-between gap-3 text-sm">
              <span>
                {l.title}
                {l.variantTitle ? ` · ${l.variantTitle}` : ""} <span className="text-muted-foreground">({money(l.unitPrice)} each)</span>
              </span>
              <Input
                type="number"
                min={0}
                max={max}
                value={qty[l.id] ?? 0}
                onChange={(e) => setQty({ ...qty, [l.id]: Math.max(0, Math.min(max, Number(e.target.value) || 0)) })}
                className="w-20"
                aria-label={`Quantity of ${l.title} to refund`}
              />
            </label>
          ) : null;
        })}
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={restock} onChange={(e) => setRestock(e.target.checked)} /> Restock refunded items
        </label>
        {calc && calc.shippingLeft > 0 ? (
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={fullShipping} onChange={(e) => setFullShipping(e.target.checked)} /> Refund shipping ({money(calc.shippingLeft)})
          </label>
        ) : null}
        {calc && (lines.length || fullShipping) ? (
          <p className="text-sm text-muted-foreground">
            Items {money(calc.subtotal)}
            {calc.tax ? ` + tax ${money(calc.tax)}` : ""}
            {calc.shipping ? ` + shipping ${money(calc.shipping)}` : ""} = {money(calc.suggested)}
          </p>
        ) : null}
        <div className="grid gap-1">
          <Label htmlFor="refund-amount">Amount ({order.currency}), up to {money(calc?.refundable ?? refundable)}</Label>
          <Input
            id="refund-amount"
            value={amount}
            onChange={(e) => {
              setTouched(true);
              setAmount(e.target.value);
            }}
            inputMode="decimal"
          />
        </div>
        <div className="grid gap-1">
          <Label htmlFor="refund-reason">Reason</Label>
          <Input id="refund-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={notify} onChange={(e) => setNotify(e.target.checked)} /> Email the customer
        </label>
        <Button
          loading={busy}
          disabled={!minor || Number.isNaN(minor) || minor > (calc?.refundable ?? refundable)}
          onClick={() =>
            void act("Refund issued", () =>
              api.POST("/api/admin/orders/{id}/refunds", {
                params: { path: { id: order.id } },
                body: { amount: minor!, lines, ...(fullShipping ? { fullShipping } : {}), ...(reason ? { reason } : {}), notify },
              }),
            )
          }
        >
          Refund {minor && !Number.isNaN(minor) ? money(minor) : ""}
        </Button>
      </CardContent>
    </Card>
  );
}

const REASONS = [
  ["size", "Size didn't fit"],
  ["unwanted", "No longer wanted"],
  ["not_as_described", "Not as described"],
  ["wrong_item", "Wrong item sent"],
  ["defective", "Damaged or defective"],
  ["style", "Style"],
  ["other", "Other"],
] as const;

/** Staff-created return (skips the request step when "approve" is ticked). */
export function ReturnPanel({ order, busy, act }: { order: Order; busy: boolean; act: Act }) {
  const returnable = order.lines.map((l) => ({ l, max: l.fulfilledQuantity - l.returnedQuantity - openReturnQty(order, l.id) })).filter((x) => x.max > 0);
  const [qty, setQty] = useState<Record<string, number>>({});
  const [reason, setReason] = useState<(typeof REASONS)[number][0]>("other");
  const [note, setNote] = useState("");
  const lines = Object.entries(qty).filter(([, q]) => q > 0).map(([orderLineId, quantity]) => ({ orderLineId, quantity, reason }));
  return (
    <Card>
      <CardHeader>
        <CardTitle>Create return</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        {returnable.length === 0 ? <p className="text-sm text-muted-foreground">Nothing shipped is left to return.</p> : null}
        {returnable.map(({ l, max }) => (
          <label key={l.id} className="flex items-center justify-between gap-3 text-sm">
            <span>
              {l.title}
              {l.variantTitle ? ` · ${l.variantTitle}` : ""}
            </span>
            <Input type="number" min={0} max={max} className="w-20" value={qty[l.id] ?? 0} aria-label={`Quantity of ${l.title} to return`} onChange={(e) => setQty({ ...qty, [l.id]: Math.max(0, Math.min(max, Number(e.target.value) || 0)) })} />
          </label>
        ))}
        <div className="grid gap-1">
          <Label htmlFor="ret-reason">Reason</Label>
          <Select id="ret-reason" value={reason} onChange={(e) => setReason(e.target.value as typeof reason)}>
            {REASONS.map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
          </Select>
        </div>
        <div className="grid gap-1">
          <Label htmlFor="ret-note">Note</Label>
          <Textarea id="ret-note" rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
        <Button
          loading={busy}
          disabled={lines.length === 0}
          onClick={() => void act("Return created", () => api.POST("/api/admin/orders/{id}/returns", { params: { path: { id: order.id } }, body: { lines, ...(note ? { note } : {}), approve: true, notify: true } }))}
        >
          Create return
        </Button>
      </CardContent>
    </Card>
  );
}

function openReturnQty(order: Order, lineId: string) {
  return order.returns
    .filter((r) => r.status === "requested" || r.status === "approved")
    .flatMap((r) => r.lines)
    .filter((l) => l.orderLineId === lineId)
    .reduce((n, l) => n + l.quantity, 0);
}

/** Return requests and their workflow: approve/decline → receive (restock) → refund/exchange/close. */
export function ReturnsCard({ order, busy, act }: { order: Order; busy: boolean; act: Act }) {
  const [resolving, setResolving] = useState<string | null>(null);
  if (order.returns.length === 0) return null;
  const lineTitle = (id: string) => order.lines.find((l) => l.id === id)?.title ?? "Item";
  const post = (r: Return, path: "approve" | "receive" | "cancel", label: string) =>
    void act(label, () =>
      path === "approve"
        ? api.POST("/api/admin/returns/{id}/approve", { params: { path: { id: r.id } }, body: { notify: true } })
        : path === "receive"
          ? api.POST("/api/admin/returns/{id}/receive", { params: { path: { id: r.id } }, body: {} })
          : api.POST("/api/admin/returns/{id}/cancel", { params: { path: { id: r.id } } }),
    );
  return (
    <Card>
      <CardHeader>
        <CardTitle>Returns</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        {order.returns.map((r) => (
          <div key={r.id} className="grid gap-2 rounded-md border border-border p-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{r.name}</span>
              <Badge variant={r.status === "requested" ? "warning" : r.status === "closed" ? "success" : "secondary"}>{human(r.status)}</Badge>
              <span className="text-muted-foreground">
                {r.requestedBy === "customer" ? "Requested by customer" : "Created by staff"} · {new Date(r.createdAt).toLocaleString()}
              </span>
            </div>
            <ul>
              {r.lines.map((l) => (
                <li key={l.id}>
                  {lineTitle(l.orderLineId)} × {l.quantity} <span className="text-muted-foreground">({human(l.reason)})</span>
                </li>
              ))}
            </ul>
            {r.customerNote ? <p className="text-muted-foreground">“{r.customerNote}”</p> : null}
            {r.declineReason ? <p className="text-muted-foreground">Declined: {r.declineReason}</p> : null}
            {r.resolution ? <p className="text-muted-foreground">Resolved: {human(r.resolution)}</p> : null}
            <div className="flex flex-wrap gap-2">
              {r.status === "requested" ? (
                <>
                  <Button size="sm" loading={busy} onClick={() => post(r, "approve", "Return approved")}>
                    Approve
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      const reason = window.prompt("Why is this return declined? The customer sees this.");
                      if (reason?.trim()) void act("Return declined", () => api.POST("/api/admin/returns/{id}/decline", { params: { path: { id: r.id } }, body: { reason, notify: true } }));
                    }}
                  >
                    Decline
                  </Button>
                </>
              ) : null}
              {r.status === "requested" || r.status === "approved" ? (
                <>
                  <Button size="sm" variant="outline" loading={busy} onClick={() => post(r, "receive", "Items received and restocked")}>
                    Mark received
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => post(r, "cancel", "Return cancelled")}>
                    Cancel return
                  </Button>
                </>
              ) : null}
              {r.status === "received" ? (
                <Button size="sm" onClick={() => setResolving(resolving === r.id ? null : r.id)}>
                  Refund or exchange
                </Button>
              ) : null}
            </div>
            {resolving === r.id ? <ResolveForm order={order} r={r} busy={busy} act={act} /> : null}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function ResolveForm({ order, r, busy, act }: { order: Order; r: Return; busy: boolean; act: Act }) {
  const [mode, setMode] = useState<"refund" | "exchange" | "none">("refund");
  const [amount, setAmount] = useState("");
  const [variantId, setVariantId] = useState("");
  const [search, setSearch] = useState("");
  const [variants, setVariants] = useState<{ variantId: string; productTitle: string; variantTitle: string | null }[]>([]);
  useEffect(() => {
    if (mode !== "exchange" || search.trim().length < 2) return;
    const t = setTimeout(() => void api.GET("/api/admin/variants/search", { params: { query: { q: search } } }).then((res) => res.data && setVariants(res.data.items)), 250);
    return () => clearTimeout(t);
  }, [mode, search]);
  const minor = amount ? fromInput(amount, order.currency) : null;
  return (
    <div className="grid gap-3 border-t border-border pt-3">
      <fieldset className="flex flex-wrap gap-4 text-sm">
        <legend className="sr-only">Resolution</legend>
        {(["refund", "exchange", "none"] as const).map((m) => (
          <label key={m} className="flex items-center gap-2">
            <input type="radio" name={`res-${r.id}`} checked={mode === m} onChange={() => setMode(m)} /> {m === "none" ? "Close without refund" : human(m)}
          </label>
        ))}
      </fieldset>
      {mode === "refund" ? (
        <div className="grid gap-1">
          <Label htmlFor={`res-amt-${r.id}`}>Amount (blank = value of returned items)</Label>
          <Input id={`res-amt-${r.id}`} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </div>
      ) : null}
      {mode === "exchange" ? (
        <div className="grid gap-1">
          <Label htmlFor={`res-var-${r.id}`}>Replacement product</Label>
          <Input id={`res-var-${r.id}`} value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search products or SKU" />
          <Select aria-label="Replacement variant" value={variantId} onChange={(e) => setVariantId(e.target.value)}>
            <option value="">Choose…</option>
            {variants.map((v) => (
              <option key={v.variantId} value={v.variantId}>
                {v.productTitle}
                {v.variantTitle ? ` · ${v.variantTitle}` : ""}
              </option>
            ))}
          </Select>
          <p className="text-xs text-muted-foreground">Creates a draft order credited with the returned value.</p>
        </div>
      ) : null}
      <Button
        size="sm"
        loading={busy}
        disabled={(mode === "exchange" && !variantId) || (minor !== null && Number.isNaN(minor))}
        onClick={() =>
          void act(mode === "refund" ? "Return refunded" : mode === "exchange" ? "Exchange draft created" : "Return closed", () =>
            api.POST("/api/admin/returns/{id}/resolve", {
              params: { path: { id: r.id } },
              body:
                mode === "refund"
                  ? { resolution: "refund", ...(minor ? { amount: minor } : {}), notify: true }
                  : mode === "exchange"
                    ? { resolution: "exchange", lines: [{ variantId, quantity: r.lines.reduce((n, l) => n + l.quantity, 0) }] }
                    : { resolution: "none" },
            }),
          )
        }
      >
        Confirm
      </Button>
    </div>
  );
}
