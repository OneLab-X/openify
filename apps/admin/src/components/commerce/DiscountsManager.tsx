"use client";
import type { Schemas } from "@shopkit/sdk";
import { Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle, Checkbox, Input, Label, Select } from "@shopkit/ui";
import { useState } from "react";
import { api, errorMessage, type JsonBody } from "@/lib/api-client";
import { formatMoney, fromInput, toInput } from "@/lib/money";
import { ResourcePicker } from "./ResourcePicker";

type Discount = Schemas["Discount"];
type Body = JsonBody<"/api/admin/discounts", "post">;
type Target = "all" | "collections" | "products";

/** Discount engine admin (Phase 4): codes and automatic discounts with every rule the engine supports. */
export function DiscountsManager({ initial, currency, canWrite }: { initial: Discount[]; currency: string; canWrite: boolean }) {
  const [items, setItems] = useState(initial);
  const [editing, setEditing] = useState<Discount | "new" | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  function describe(d: Discount) {
    if (d.kind === "percentage") return `${d.value / 100}% off ${d.target === "all" ? "order" : d.target}`;
    if (d.kind === "fixed_amount") return `${formatMoney(d.value, currency)} off${d.perItem ? " each item" : ""}`;
    if (d.kind === "free_shipping") return `Free shipping${d.maxShippingAmount ? ` up to ${formatMoney(d.maxShippingAmount, currency)}` : ""}`;
    const b = d.bxgy;
    return b ? `Buy ${b.buy.quantity}, get ${b.get.quantity} at ${b.get.percentOff === 10_000 ? "free" : `${b.get.percentOff / 100}% off`}` : "Buy X get Y";
  }

  async function toggle(d: Discount) {
    const { data, error } = await api.PUT("/api/admin/discounts/{id}", { params: { path: { id: d.id } }, body: { ...toBody(d), status: d.status === "active" ? "disabled" : "active" } });
    if (data) setItems(items.map((x) => (x.id === d.id ? data : x)));
    else setMsg({ ok: false, text: errorMessage(error) });
  }

  async function remove(d: Discount) {
    if (!window.confirm(`Delete “${d.title}”?`)) return;
    const { error } = await api.DELETE("/api/admin/discounts/{id}", { params: { path: { id: d.id } } });
    if (error) setMsg({ ok: false, text: errorMessage(error) });
    else setItems(items.filter((x) => x.id !== d.id));
  }

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Discounts</h1>
        {canWrite ? <Button onClick={() => setEditing("new")}>Create discount</Button> : null}
      </div>
      {msg ? <Alert variant={msg.ok ? "success" : "error"}>{msg.text}</Alert> : null}
      {editing ? (
        <DiscountEditor
          key={editing === "new" ? "new" : editing.id}
          initial={editing === "new" ? null : editing}
          currency={currency}
          onCancel={() => setEditing(null)}
          onSaved={(d) => {
            setItems(editing === "new" ? [d, ...items] : items.map((x) => (x.id === d.id ? d : x)));
            setEditing(null);
            setMsg({ ok: true, text: `${d.code ? d.code.toUpperCase() : d.title} saved` });
          }}
        />
      ) : null}
      <Card>
        <CardContent className="overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">Discount</th>
                <th className="px-4 py-2 font-medium">Type</th>
                <th className="px-4 py-2 font-medium">Used</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-6 text-center text-muted-foreground">
                    No discounts yet.
                  </td>
                </tr>
              ) : null}
              {items.map((d) => (
                <tr key={d.id} className="border-b border-border last:border-0">
                  <td className="px-4 py-2">
                    <span className="font-medium">{d.code ? d.code.toUpperCase() : d.title}</span>
                    <span className="block text-xs text-muted-foreground">{d.method === "automatic" ? "Automatic" : d.title}</span>
                  </td>
                  <td className="px-4 py-2">{describe(d)}</td>
                  <td className="px-4 py-2">
                    {d.usageCount}
                    {d.usageLimit ? ` / ${d.usageLimit}` : ""}
                  </td>
                  <td className="px-4 py-2">
                    <Badge variant={d.status === "active" ? "success" : "outline"}>{d.status}</Badge>
                    {d.endsAt && new Date(d.endsAt) < new Date() ? <span className="ml-1 text-xs text-muted-foreground">ended</span> : null}
                  </td>
                  <td className="whitespace-nowrap px-4 py-2 text-right">
                    {canWrite ? (
                      <>
                        <Button variant="ghost" size="sm" onClick={() => setEditing(d)}>
                          Edit
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => void toggle(d)}>
                          {d.status === "active" ? "Disable" : "Enable"}
                        </Button>
                        <Button variant="ghost" size="sm" onClick={() => void remove(d)}>
                          Delete
                        </Button>
                      </>
                    ) : null}
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

function toBody(d: Discount): Body {
  return {
    title: d.title,
    method: d.method,
    code: d.code,
    kind: d.kind,
    value: d.value,
    target: d.target,
    productIds: d.productIds,
    collectionIds: d.collectionIds,
    perItem: d.perItem,
    bxgy: d.bxgy,
    minSubtotal: d.minSubtotal,
    minQuantity: d.minQuantity,
    maxShippingAmount: d.maxShippingAmount,
    eligibility: d.eligibility,
    customerIds: d.customerIds,
    customerTags: d.customerTags,
    startsAt: d.startsAt,
    endsAt: d.endsAt,
    usageLimit: d.usageLimit,
    usageLimitPerCustomer: d.usageLimitPerCustomer,
    combinesWith: d.combinesWith,
    status: d.status,
  };
}

const local = (iso: string | null) => (iso ? new Date(new Date(iso).getTime() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16) : "");
const intOrNull = (v: string) => (v.trim() ? Math.max(1, Math.floor(Number(v))) : null);

function DiscountEditor({ initial, currency, onCancel, onSaved }: { initial: Discount | null; currency: string; onCancel: () => void; onSaved: (d: Discount) => void }) {
  const d = initial;
  const [f, setF] = useState({
    title: d?.title ?? "",
    method: d?.method ?? ("code"),
    code: d?.code ?? "",
    kind: d?.kind ?? ("percentage"),
    value: d ? (d.kind === "percentage" ? String(d.value / 100) : d.kind === "fixed_amount" ? toInput(d.value, currency) : "") : "",
    target: d?.target ?? ("all"),
    productIds: d?.productIds ?? [],
    collectionIds: d?.collectionIds ?? [],
    perItem: d?.perItem ?? false,
    buyQty: String(d?.bxgy?.buy.quantity ?? 1),
    buyTarget: d?.bxgy?.buy.target ?? ("all"),
    buyProducts: d?.bxgy?.buy.productIds ?? [],
    buyCollections: d?.bxgy?.buy.collectionIds ?? [],
    getQty: String(d?.bxgy?.get.quantity ?? 1),
    getTarget: d?.bxgy?.get.target ?? ("all"),
    getProducts: d?.bxgy?.get.productIds ?? [],
    getCollections: d?.bxgy?.get.collectionIds ?? [],
    getPercent: String((d?.bxgy?.get.percentOff ?? 10_000) / 100),
    usesPerOrder: d?.bxgy?.usesPerOrder ? String(d.bxgy.usesPerOrder) : "1",
    minRequirement: d?.minSubtotal ? "subtotal" : d?.minQuantity ? "quantity" : "none",
    minSubtotal: toInput(d?.minSubtotal, currency),
    minQuantity: d?.minQuantity ? String(d.minQuantity) : "",
    maxShipping: toInput(d?.maxShippingAmount, currency),
    eligibility: d?.eligibility ?? ("all"),
    customerIds: d?.customerIds ?? [],
    customerTags: (d?.customerTags ?? []).join(", "),
    usageLimit: d?.usageLimit ? String(d.usageLimit) : "",
    perCustomer: d?.usageLimitPerCustomer ? String(d.usageLimitPerCustomer) : "",
    startsAt: local(d?.startsAt ?? null),
    endsAt: local(d?.endsAt ?? null),
    combinesWith: d?.combinesWith ?? { product: false, order: false, shipping: false },
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const money = (v: string) => {
    const n = fromInput(v, currency);
    return n === null || Number.isNaN(n) ? null : n;
  };

  async function save() {
    const value = f.kind === "percentage" ? Math.round(Number(f.value) * 100) : f.kind === "fixed_amount" ? (money(f.value) ?? 0) : 0;
    const body: Body = {
      title: f.title || f.code || "Discount",
      method: f.method,
      code: f.method === "code" ? f.code : null,
      kind: f.kind,
      value,
      target: f.kind === "buy_x_get_y" ? "all" : f.target,
      productIds: f.target === "products" ? f.productIds : [],
      collectionIds: f.target === "collections" ? f.collectionIds : [],
      perItem: f.kind === "fixed_amount" && f.target !== "all" ? f.perItem : false,
      bxgy:
        f.kind === "buy_x_get_y"
          ? {
              buy: { quantity: Number(f.buyQty) || 1, target: f.buyTarget, productIds: f.buyTarget === "products" ? f.buyProducts : [], collectionIds: f.buyTarget === "collections" ? f.buyCollections : [] },
              get: {
                quantity: Number(f.getQty) || 1,
                target: f.getTarget,
                productIds: f.getTarget === "products" ? f.getProducts : [],
                collectionIds: f.getTarget === "collections" ? f.getCollections : [],
                percentOff: Math.round(Number(f.getPercent) * 100) || 10_000,
              },
              usesPerOrder: intOrNull(f.usesPerOrder),
            }
          : null,
      minSubtotal: f.minRequirement === "subtotal" ? money(f.minSubtotal) : null,
      minQuantity: f.minRequirement === "quantity" ? intOrNull(f.minQuantity) : null,
      maxShippingAmount: f.kind === "free_shipping" ? money(f.maxShipping) : null,
      eligibility: f.eligibility,
      customerIds: f.eligibility === "customers" ? f.customerIds : [],
      customerTags: f.eligibility === "tags" ? f.customerTags.split(",").map((t) => t.trim()).filter(Boolean) : [],
      usageLimit: intOrNull(f.usageLimit),
      usageLimitPerCustomer: intOrNull(f.perCustomer),
      startsAt: f.startsAt ? new Date(f.startsAt).toISOString() : null,
      endsAt: f.endsAt ? new Date(f.endsAt).toISOString() : null,
      combinesWith: f.combinesWith,
      status: d?.status ?? "active",
    };
    setBusy(true);
    setError(null);
    const res = d ? await api.PUT("/api/admin/discounts/{id}", { params: { path: { id: d.id } }, body }) : await api.POST("/api/admin/discounts", { body });
    setBusy(false);
    if (res.data) onSaved(res.data);
    else setError(errorMessage(res.error));
  }

  const targetPicker = (prefix: "" | "buy" | "get", target: Target, setTarget: (t: Target) => void, products: string[], setProducts: (v: string[]) => void, collections: string[], setCollections: (v: string[]) => void, legend: string) => (
    <fieldset className="grid gap-2">
      <legend className="mb-1 text-sm font-medium">{legend}</legend>
      <div className="flex flex-wrap gap-4 text-sm">
        {(["all", "collections", "products"] as const).map((t) => (
          <label key={t} className="flex items-center gap-2">
            <input type="radio" name={`${prefix}target`} checked={target === t} onChange={() => setTarget(t)} /> {t === "all" ? "Any product" : t === "collections" ? "Specific collections" : "Specific products"}
          </label>
        ))}
      </div>
      {target === "products" ? <ResourcePicker kind="products" label="Products" value={products} onChange={setProducts} /> : null}
      {target === "collections" ? <ResourcePicker kind="collections" label="Collections" value={collections} onChange={setCollections} /> : null}
    </fieldset>
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>{d ? `Edit ${d.code ? d.code.toUpperCase() : d.title}` : "New discount"}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-6">
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="grid gap-1">
            <Label htmlFor="d-method">Method</Label>
            <Select id="d-method" value={f.method} onChange={(e) => set("method", e.target.value as typeof f.method)}>
              <option value="code">Discount code</option>
              <option value="automatic">Automatic discount</option>
            </Select>
          </div>
          {f.method === "code" ? (
            <div className="grid gap-1">
              <Label htmlFor="d-code">Code</Label>
              <Input id="d-code" value={f.code} onChange={(e) => set("code", e.target.value.toUpperCase())} autoComplete="off" />
            </div>
          ) : null}
          <div className="grid gap-1">
            <Label htmlFor="d-title">{f.method === "code" ? "Internal name (optional)" : "Title shown at checkout"}</Label>
            <Input id="d-title" value={f.title} onChange={(e) => set("title", e.target.value)} />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="d-kind">Type</Label>
            <Select id="d-kind" value={f.kind} onChange={(e) => set("kind", e.target.value as typeof f.kind)}>
              <option value="percentage">Percentage off</option>
              <option value="fixed_amount">Fixed amount off</option>
              <option value="free_shipping">Free shipping</option>
              <option value="buy_x_get_y">Buy X get Y</option>
            </Select>
          </div>
          {f.kind === "percentage" || f.kind === "fixed_amount" ? (
            <div className="grid gap-1">
              <Label htmlFor="d-value">{f.kind === "percentage" ? "Percent off" : `Amount off (${currency})`}</Label>
              <Input id="d-value" value={f.value} onChange={(e) => set("value", e.target.value)} inputMode="decimal" />
            </div>
          ) : null}
          {f.kind === "free_shipping" ? (
            <div className="grid gap-1">
              <Label htmlFor="d-maxship">Only for shipping rates up to ({currency}, optional)</Label>
              <Input id="d-maxship" value={f.maxShipping} onChange={(e) => set("maxShipping", e.target.value)} inputMode="decimal" />
            </div>
          ) : null}
        </div>

        {f.kind === "percentage" || f.kind === "fixed_amount"
          ? targetPicker("", f.target, (t) => set("target", t), f.productIds, (v) => set("productIds", v), f.collectionIds, (v) => set("collectionIds", v), "Applies to")
          : null}
        {f.kind === "fixed_amount" && f.target !== "all" ? (
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={f.perItem} onChange={(e) => set("perItem", e.target.checked)} /> Take the amount off each eligible item (otherwise once per order)
          </label>
        ) : null}

        {f.kind === "buy_x_get_y" ? (
          <div className="grid gap-4 rounded-md border border-border p-4">
            <div className="grid gap-1 sm:w-40">
              <Label htmlFor="d-buyqty">Customer buys (quantity)</Label>
              <Input id="d-buyqty" type="number" min={1} value={f.buyQty} onChange={(e) => set("buyQty", e.target.value)} />
            </div>
            {targetPicker("buy", f.buyTarget, (t) => set("buyTarget", t), f.buyProducts, (v) => set("buyProducts", v), f.buyCollections, (v) => set("buyCollections", v), "Of")}
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="grid gap-1">
                <Label htmlFor="d-getqty">Customer gets (quantity)</Label>
                <Input id="d-getqty" type="number" min={1} value={f.getQty} onChange={(e) => set("getQty", e.target.value)} />
              </div>
              <div className="grid gap-1">
                <Label htmlFor="d-getpct">At percent off (100 = free)</Label>
                <Input id="d-getpct" inputMode="decimal" value={f.getPercent} onChange={(e) => set("getPercent", e.target.value)} />
              </div>
              <div className="grid gap-1">
                <Label htmlFor="d-uses">Max uses per order (blank = no limit)</Label>
                <Input id="d-uses" type="number" min={1} value={f.usesPerOrder} onChange={(e) => set("usesPerOrder", e.target.value)} />
              </div>
            </div>
            {targetPicker("get", f.getTarget, (t) => set("getTarget", t), f.getProducts, (v) => set("getProducts", v), f.getCollections, (v) => set("getCollections", v), "Of")}
          </div>
        ) : null}

        <fieldset className="grid gap-2">
          <legend className="mb-1 text-sm font-medium">Minimum requirement</legend>
          <div className="flex flex-wrap gap-4 text-sm">
            {(
              [
                ["none", "None"],
                ["subtotal", `Minimum purchase (${currency})`],
                ["quantity", "Minimum quantity of items"],
              ] as const
            ).map(([v, label]) => (
              <label key={v} className="flex items-center gap-2">
                <input type="radio" name="minreq" checked={f.minRequirement === v} onChange={() => set("minRequirement", v)} /> {label}
              </label>
            ))}
          </div>
          {f.minRequirement === "subtotal" ? <Input aria-label="Minimum purchase amount" className="sm:w-48" inputMode="decimal" value={f.minSubtotal} onChange={(e) => set("minSubtotal", e.target.value)} /> : null}
          {f.minRequirement === "quantity" ? <Input aria-label="Minimum quantity" className="sm:w-48" type="number" min={1} value={f.minQuantity} onChange={(e) => set("minQuantity", e.target.value)} /> : null}
        </fieldset>

        <fieldset className="grid gap-2">
          <legend className="mb-1 text-sm font-medium">Customer eligibility</legend>
          <div className="flex flex-wrap gap-4 text-sm">
            {(
              [
                ["all", "Everyone"],
                ["customers", "Specific customers"],
                ["tags", "Customers with tags"],
              ] as const
            ).map(([v, label]) => (
              <label key={v} className="flex items-center gap-2">
                <input type="radio" name="elig" checked={f.eligibility === v} onChange={() => set("eligibility", v)} /> {label}
              </label>
            ))}
          </div>
          {f.eligibility === "customers" ? <ResourcePicker kind="customers" label="Customers" value={f.customerIds} onChange={(v) => set("customerIds", v)} /> : null}
          {f.eligibility === "tags" ? <Input aria-label="Customer tags, comma separated" placeholder="vip, wholesale" value={f.customerTags} onChange={(e) => set("customerTags", e.target.value)} /> : null}
        </fieldset>

        <div className="grid gap-3 sm:grid-cols-4">
          <div className="grid gap-1">
            <Label htmlFor="d-limit">Total uses (blank = unlimited)</Label>
            <Input id="d-limit" type="number" min={1} value={f.usageLimit} onChange={(e) => set("usageLimit", e.target.value)} />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="d-percust">Uses per customer</Label>
            <Input id="d-percust" type="number" min={1} value={f.perCustomer} onChange={(e) => set("perCustomer", e.target.value)} />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="d-starts">Starts</Label>
            <Input id="d-starts" type="datetime-local" value={f.startsAt} onChange={(e) => set("startsAt", e.target.value)} />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="d-ends">Ends</Label>
            <Input id="d-ends" type="datetime-local" value={f.endsAt} onChange={(e) => set("endsAt", e.target.value)} />
          </div>
        </div>

        <fieldset className="grid gap-2">
          <legend className="mb-1 text-sm font-medium">Combines with</legend>
          <div className="flex flex-wrap gap-4 text-sm">
            {(
              [
                ["product", "Product discounts"],
                ["order", "Order discounts"],
                ["shipping", "Shipping discounts"],
              ] as const
            ).map(([k, label]) => (
              <label key={k} className="flex items-center gap-2">
                <Checkbox checked={f.combinesWith[k]} onChange={(e) => set("combinesWith", { ...f.combinesWith, [k]: e.target.checked })} /> {label}
              </label>
            ))}
          </div>
        </fieldset>

        {error ? <Alert variant="error">{error}</Alert> : null}
        <div className="flex gap-2">
          <Button loading={busy} onClick={() => void save()}>
            Save discount
          </Button>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
