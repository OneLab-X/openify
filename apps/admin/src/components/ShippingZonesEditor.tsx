"use client";
import type { Schemas } from "@shopkit/sdk";
import { Alert, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Checkbox, Input, Label, Select, Textarea } from "@shopkit/ui";
import { useState } from "react";
import { api, errorMessage, type JsonBody } from "@/lib/api-client";
import { formatMoney, fromInput, toInput } from "@/lib/money";

type Shipping = Schemas["ShippingSettings"];
type Zone = Shipping["zones"][number];
type Rate = Schemas["ShippingRateAdmin"];
type RateBody = JsonBody<"/api/admin/shipping/rates", "post">;
type Kind = Rate["kind"];

const KIND_LABEL: Record<Kind, string> = {
  flat: "Flat rate",
  weight: "By weight",
  price: "By order value",
  carrier: "Carrier-calculated",
  local_pickup: "Local pickup",
  local_delivery: "Local delivery (by PIN)",
};
const list = (v: string) => v.split(/[,\n]/).map((x) => x.trim()).filter(Boolean);

/**
 * Shipping zones (countries → states → PIN prefixes; the most specific zone wins) and their rates,
 * plus local pickup and local delivery. With no zones, checkout uses the default flat rate above.
 */
export function ShippingZonesEditor({ initial, currency, locations, carriers }: { initial: Shipping; currency: string; locations: { id: string; name: string }[]; carriers: { id: string; displayName: string }[] }) {
  const [data, setData] = useState(initial);
  const [editingZone, setEditingZone] = useState<Zone | "new" | null>(null);
  const [editingRate, setEditingRate] = useState<{ rate: Rate | null; zoneId: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const money = (n: number) => formatMoney(n, currency);

  async function run(p: Promise<{ data?: Shipping; error?: unknown }>) {
    const { data: next, error: err } = await p;
    if (next) {
      setData(next);
      setError(null);
      setEditingZone(null);
      setEditingRate(null);
    } else setError(errorMessage(err));
  }

  function describe(r: Rate) {
    const base = r.kind === "carrier" ? `${r.provider ?? "carrier"} live rates` : r.amount === 0 ? "Free" : money(r.amount);
    const cond =
      r.kind === "weight" && (r.minValue !== null || r.maxValue !== null)
        ? ` · ${r.minValue ?? 0}–${r.maxValue ?? "∞"} g`
        : r.kind === "price" && (r.minValue !== null || r.maxValue !== null)
          ? ` · order ${money(r.minValue ?? 0)}–${r.maxValue !== null ? money(r.maxValue) : "∞"}`
          : "";
    return `${base}${cond}${r.freeOver !== null ? ` · free over ${money(r.freeOver)}` : ""}`;
  }

  const rateRow = (r: Rate) => (
    <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
      <span>
        <span className="font-medium">{r.name}</span> <span className="text-muted-foreground">· {KIND_LABEL[r.kind]} · {describe(r)}</span>
        {r.kind === "local_delivery" ? <span className="block text-xs text-muted-foreground">PIN: {r.postalPrefixes.join(", ")}</span> : null}
        {!r.active ? (
          <Badge variant="outline" className="ml-2">
            off
          </Badge>
        ) : null}
      </span>
      <span>
        <Button size="sm" variant="ghost" onClick={() => setEditingRate({ rate: r, zoneId: r.zoneId })}>
          Edit
        </Button>
        <Button size="sm" variant="ghost" onClick={() => window.confirm(`Delete ${r.name}?`) && void run(api.DELETE("/api/admin/shipping/rates/{id}", { params: { path: { id: r.id } } }))}>
          Delete
        </Button>
      </span>
    </li>
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Shipping zones and rates</CardTitle>
        <CardDescription>The most specific zone for the address wins: PIN prefix, then state, then country, then rest of world (*).</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {error ? <Alert variant="error">{error}</Alert> : null}
        {data.zones.length === 0 ? <p className="text-sm text-muted-foreground">No zones yet — checkout uses the default rate above.</p> : null}
        {data.zones.map((z) => (
          <div key={z.id} className="grid gap-2 rounded-md border border-border p-3 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="font-medium">{z.name}</p>
                <p className="text-xs text-muted-foreground">
                  {z.countries
                    .map((c) => `${c.country === "*" ? "Rest of world" : c.country}${c.provinces.length ? ` (${c.provinces.join(", ")})` : ""}${c.postalPrefixes.length ? ` PIN ${c.postalPrefixes.join(", ")}` : ""}`)
                    .join(" · ")}
                </p>
              </div>
              <span>
                <Button size="sm" variant="outline" onClick={() => setEditingRate({ rate: null, zoneId: z.id })}>
                  Add rate
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setEditingZone(z)}>
                  Edit zone
                </Button>
                <Button size="sm" variant="ghost" onClick={() => window.confirm(`Delete zone ${z.name} and its rates?`) && void run(api.DELETE("/api/admin/shipping/zones/{id}", { params: { path: { id: z.id } } }))}>
                  Delete
                </Button>
              </span>
            </div>
            {z.rates.length ? <ul className="divide-y divide-border">{z.rates.map(rateRow)}</ul> : <p className="text-muted-foreground">No rates — addresses in this zone cannot check out.</p>}
            {editingRate && editingRate.zoneId === z.id ? <RateForm key={editingRate.rate?.id ?? "new"} rate={editingRate.rate} zoneId={z.id} currency={currency} locations={locations} carriers={carriers} onCancel={() => setEditingRate(null)} onSave={(body, id) => void run(id ? api.PUT("/api/admin/shipping/rates/{id}", { params: { path: { id } }, body }) : api.POST("/api/admin/shipping/rates", { body }))} /> : null}
          </div>
        ))}
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => setEditingZone("new")}>
            Add zone
          </Button>
          <Button variant="outline" onClick={() => setEditingRate({ rate: null, zoneId: null })}>
            Add local pickup / delivery
          </Button>
        </div>
        {editingZone ? (
          <ZoneForm
            key={editingZone === "new" ? "new" : editingZone.id}
            zone={editingZone === "new" ? null : editingZone}
            onCancel={() => setEditingZone(null)}
            onSave={(body, id) => void run(id ? api.PUT("/api/admin/shipping/zones/{id}", { params: { path: { id } }, body }) : api.POST("/api/admin/shipping/zones", { body }))}
          />
        ) : null}
        {data.localRates.length ? (
          <div className="grid gap-1 text-sm">
            <p className="font-medium">Local pickup and delivery</p>
            <ul className="divide-y divide-border">{data.localRates.map(rateRow)}</ul>
          </div>
        ) : null}
        {editingRate && editingRate.zoneId === null ? <RateForm key={editingRate.rate?.id ?? "new-local"} rate={editingRate.rate} zoneId={null} currency={currency} locations={locations} carriers={carriers} onCancel={() => setEditingRate(null)} onSave={(body, id) => void run(id ? api.PUT("/api/admin/shipping/rates/{id}", { params: { path: { id } }, body }) : api.POST("/api/admin/shipping/rates", { body }))} /> : null}
      </CardContent>
    </Card>
  );
}

function ZoneForm({ zone, onCancel, onSave }: { zone: Zone | null; onCancel: () => void; onSave: (body: JsonBody<"/api/admin/shipping/zones", "post">, id?: string) => void }) {
  const [name, setName] = useState(zone?.name ?? "");
  const [rows, setRows] = useState((zone?.countries ?? [{ country: "", provinces: [], postalPrefixes: [] }]).map((c) => ({ country: c.country, provinces: c.provinces.join(", "), prefixes: c.postalPrefixes.join(", ") })));
  return (
    <div className="grid gap-3 rounded-md border border-border p-3">
      <div className="grid gap-1 sm:w-72">
        <Label htmlFor="zone-name">Zone name</Label>
        <Input id="zone-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="India, Bengaluru city, Europe…" />
      </div>
      {rows.map((r, i) => (
        <fieldset key={i} className="grid gap-2 sm:grid-cols-[6rem_1fr_1fr_auto] sm:items-end">
          <legend className="sr-only">Region {i + 1}</legend>
          <div className="grid gap-1">
            <Label htmlFor={`zc-${i}`}>Country</Label>
            <Input id={`zc-${i}`} value={r.country} maxLength={2} placeholder="IN or *" onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, country: e.target.value.toUpperCase() } : x)))} />
          </div>
          <div className="grid gap-1">
            <Label htmlFor={`zp-${i}`}>States (optional)</Label>
            <Input id={`zp-${i}`} value={r.provinces} placeholder="Karnataka, Kerala" onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, provinces: e.target.value } : x)))} />
          </div>
          <div className="grid gap-1">
            <Label htmlFor={`zx-${i}`}>PIN prefixes (optional)</Label>
            <Input id={`zx-${i}`} value={r.prefixes} placeholder="560, 5601" onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, prefixes: e.target.value } : x)))} />
          </div>
          <Button variant="ghost" size="sm" disabled={rows.length === 1} onClick={() => setRows(rows.filter((_, j) => j !== i))}>
            Remove
          </Button>
        </fieldset>
      ))}
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" onClick={() => setRows([...rows, { country: "", provinces: "", prefixes: "" }])}>
          Add country
        </Button>
        <Button size="sm" onClick={() => onSave({ name, countries: rows.filter((r) => r.country).map((r) => ({ country: r.country, provinces: list(r.provinces), postalPrefixes: list(r.prefixes) })) }, zone?.id)}>
          Save zone
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function RateForm({
  rate,
  zoneId,
  currency,
  locations,
  carriers,
  onCancel,
  onSave,
}: {
  rate: Rate | null;
  zoneId: string | null;
  currency: string;
  locations: { id: string; name: string }[];
  carriers: { id: string; displayName: string }[];
  onCancel: () => void;
  onSave: (body: RateBody, id?: string) => void;
}) {
  const kinds: Kind[] = zoneId ? ["flat", "weight", "price", ...(carriers.length ? (["carrier"] as const) : [])] : ["local_pickup", "local_delivery"];
  const [f, setF] = useState({
    name: rate?.name ?? "",
    description: rate?.description ?? "",
    kind: rate?.kind ?? kinds[0]!,
    amount: toInput(rate?.amount ?? 0, currency),
    min: rate?.minValue === null || rate?.minValue === undefined ? "" : rate.kind === "price" ? toInput(rate.minValue, currency) : String(rate.minValue),
    max: rate?.maxValue === null || rate?.maxValue === undefined ? "" : rate.kind === "price" ? toInput(rate.maxValue, currency) : String(rate.maxValue),
    freeOver: toInput(rate?.freeOver, currency),
    prefixes: (rate?.postalPrefixes ?? []).join(", "),
    locationId: rate?.locationId ?? locations[0]?.id ?? "",
    provider: rate?.provider ?? carriers[0]?.id ?? "",
    active: rate?.active ?? true,
  });
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const minor = (v: string) => {
    const n = fromInput(v, currency);
    return n === null || Number.isNaN(n) ? null : n;
  };
  const bound = (v: string) => (v.trim() === "" ? null : f.kind === "price" ? minor(v) : Math.max(0, Math.round(Number(v))));

  function save() {
    onSave(
      {
        zoneId,
        name: f.name,
        ...(f.description ? { description: f.description } : {}),
        kind: f.kind,
        amount: minor(f.amount) ?? 0,
        minValue: f.kind === "weight" || f.kind === "price" ? bound(f.min) : null,
        maxValue: f.kind === "weight" || f.kind === "price" ? bound(f.max) : null,
        freeOver: minor(f.freeOver),
        postalPrefixes: f.kind === "local_delivery" ? list(f.prefixes) : [],
        locationId: f.kind === "local_pickup" ? f.locationId || null : null,
        provider: f.kind === "carrier" ? f.provider || null : null,
        active: f.active,
      },
      rate?.id,
    );
  }

  return (
    <div className="grid gap-3 rounded-md bg-muted/50 p-3 sm:grid-cols-3">
      <div className="grid gap-1">
        <Label htmlFor="rate-kind">Type</Label>
        <Select id="rate-kind" value={f.kind} onChange={(e) => set("kind", e.target.value as Kind)}>
          {kinds.map((k) => (
            <option key={k} value={k}>
              {KIND_LABEL[k]}
            </option>
          ))}
        </Select>
      </div>
      <div className="grid gap-1">
        <Label htmlFor="rate-name">Name shown at checkout</Label>
        <Input id="rate-name" value={f.name} onChange={(e) => set("name", e.target.value)} placeholder="Standard, Express…" />
      </div>
      {f.kind !== "carrier" ? (
        <div className="grid gap-1">
          <Label htmlFor="rate-amount">Price ({currency})</Label>
          <Input id="rate-amount" inputMode="decimal" value={f.amount} onChange={(e) => set("amount", e.target.value)} />
        </div>
      ) : (
        <div className="grid gap-1">
          <Label htmlFor="rate-provider">Carrier</Label>
          <Select id="rate-provider" value={f.provider} onChange={(e) => set("provider", e.target.value)}>
            {carriers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.displayName}
              </option>
            ))}
          </Select>
        </div>
      )}
      {f.kind === "weight" || f.kind === "price" ? (
        <>
          <div className="grid gap-1">
            <Label htmlFor="rate-min">{f.kind === "weight" ? "From weight (g)" : `From order value (${currency})`}</Label>
            <Input id="rate-min" inputMode="decimal" value={f.min} onChange={(e) => set("min", e.target.value)} />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="rate-max">{f.kind === "weight" ? "Up to weight (g)" : `Up to order value (${currency})`}</Label>
            <Input id="rate-max" inputMode="decimal" value={f.max} onChange={(e) => set("max", e.target.value)} />
          </div>
        </>
      ) : null}
      {f.kind === "local_pickup" ? (
        <div className="grid gap-1">
          <Label htmlFor="rate-loc">Pickup location</Label>
          <Select id="rate-loc" value={f.locationId} onChange={(e) => set("locationId", e.target.value)}>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </Select>
        </div>
      ) : null}
      {f.kind === "local_delivery" ? (
        <div className="grid gap-1 sm:col-span-3">
          <Label htmlFor="rate-pins">PIN codes or prefixes you deliver to</Label>
          <Textarea id="rate-pins" rows={2} value={f.prefixes} onChange={(e) => set("prefixes", e.target.value)} placeholder="560001, 560002, 5601" />
        </div>
      ) : null}
      <div className="grid gap-1">
        <Label htmlFor="rate-free">Free over ({currency}, optional)</Label>
        <Input id="rate-free" inputMode="decimal" value={f.freeOver} onChange={(e) => set("freeOver", e.target.value)} />
      </div>
      <div className="grid gap-1 sm:col-span-2">
        <Label htmlFor="rate-desc">Description (optional)</Label>
        <Input id="rate-desc" value={f.description} onChange={(e) => set("description", e.target.value)} placeholder="2–4 business days" />
      </div>
      <label className="flex items-center gap-2 text-sm">
        <Checkbox checked={f.active} onChange={(e) => set("active", e.target.checked)} /> Active
      </label>
      <div className="flex gap-2 sm:col-span-2">
        <Button size="sm" onClick={save}>
          Save rate
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
