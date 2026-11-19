"use client";
import type { Schemas } from "@shopkit/sdk";
import { Alert, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Checkbox, Input, Label, Select } from "@shopkit/ui";
import { useState } from "react";
import { api, errorMessage } from "@/lib/api-client";

type Tax = Schemas["TaxSettings"];
type TaxConfig = Schemas["Settings"]["tax"];

const pct = (bps: number) => `${bps / 100}%`;
const toBps = (v: string) => Math.round(Number(v) * 100);

/** Region rates (VAT / sales tax by country and state), per-collection overrides and tax on shipping. */
export function TaxRatesEditor({ initial, config, collections }: { initial: Tax; config: TaxConfig; collections: { id: string; title: string }[] }) {
  const [tax, setTax] = useState(initial);
  const [cfg, setCfg] = useState(config);
  const [error, setError] = useState<string | null>(null);
  const [rate, setRate] = useState({ country: "", province: "", name: "", rate: "" });
  const [ov, setOv] = useState({ collectionId: collections[0]?.id ?? "", country: "", province: "", rate: "" });
  const title = (id: string) => collections.find((c) => c.id === id)?.title ?? "Collection";

  async function run(p: Promise<{ data?: Tax; error?: unknown }>) {
    const { data, error: err } = await p;
    if (data) {
      setTax(data);
      setError(null);
    } else setError(errorMessage(err));
  }
  async function saveConfig(next: TaxConfig) {
    const { error: err } = await api.PUT("/api/admin/settings/{key}", { params: { path: { key: "tax.config" } }, body: { value: next } });
    if (err) setError(errorMessage(err));
    else setCfg(next);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Tax rates</CardTitle>
        <CardDescription>
          {cfg.mode === "india_gst"
            ? "GST: CGST + SGST when shipping inside your registered state, IGST otherwise; HSN codes come from each variant. Exports are zero-rated."
            : "Rates by country and state override the default rate. Collection overrides win over both."}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-5">
        {error ? <Alert variant="error">{error}</Alert> : null}
        <div className="flex flex-wrap gap-4 text-sm">
          <label className="flex items-center gap-2">
            <Checkbox checked={!!cfg.taxShipping} onChange={(e) => void saveConfig({ ...cfg, taxShipping: e.target.checked })} /> Charge tax on shipping
          </label>
          <label className="flex items-center gap-2">
            <Checkbox checked={cfg.pricesIncludeTax} onChange={(e) => void saveConfig({ ...cfg, pricesIncludeTax: e.target.checked })} /> Prices include tax
          </label>
        </div>

        <section aria-labelledby="tax-regions" className="grid gap-2">
          <h3 id="tax-regions" className="text-sm font-medium">
            Region rates
          </h3>
          {tax.rates.length ? (
            <ul className="divide-y divide-border text-sm">
              {tax.rates.map((r) => (
                <li key={r.id} className="flex items-center justify-between py-1.5">
                  <span>
                    {r.country}
                    {r.province ? ` · ${r.province}` : ""} — {r.name} {pct(r.rateBps)}
                  </span>
                  <Button size="sm" variant="ghost" onClick={() => void run(api.DELETE("/api/admin/tax/rates/{id}", { params: { path: { id: r.id } } }))}>
                    Delete
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">No region rates; the default rate applies everywhere.</p>
          )}
          <div className="grid gap-2 sm:grid-cols-[5rem_1fr_1fr_6rem_auto] sm:items-end">
            <div className="grid gap-1">
              <Label htmlFor="tr-country">Country</Label>
              <Input id="tr-country" maxLength={2} value={rate.country} onChange={(e) => setRate({ ...rate, country: e.target.value.toUpperCase() })} />
            </div>
            <div className="grid gap-1">
              <Label htmlFor="tr-prov">State (optional)</Label>
              <Input id="tr-prov" value={rate.province} onChange={(e) => setRate({ ...rate, province: e.target.value })} />
            </div>
            <div className="grid gap-1">
              <Label htmlFor="tr-name">Name</Label>
              <Input id="tr-name" value={rate.name} placeholder="VAT" onChange={(e) => setRate({ ...rate, name: e.target.value })} />
            </div>
            <div className="grid gap-1">
              <Label htmlFor="tr-rate">Rate %</Label>
              <Input id="tr-rate" inputMode="decimal" value={rate.rate} onChange={(e) => setRate({ ...rate, rate: e.target.value })} />
            </div>
            <Button
              variant="outline"
              disabled={!rate.country || !rate.name || !rate.rate}
              onClick={() => {
                void run(api.POST("/api/admin/tax/rates", { body: { country: rate.country, ...(rate.province ? { province: rate.province } : {}), name: rate.name, rateBps: toBps(rate.rate) } }));
                setRate({ country: "", province: "", name: "", rate: "" });
              }}
            >
              Add
            </Button>
          </div>
        </section>

        <section aria-labelledby="tax-overrides" className="grid gap-2">
          <h3 id="tax-overrides" className="text-sm font-medium">
            Collection overrides
          </h3>
          {tax.overrides.length ? (
            <ul className="divide-y divide-border text-sm">
              {tax.overrides.map((o) => (
                <li key={o.id} className="flex items-center justify-between py-1.5">
                  <span>
                    {title(o.collectionId)} — {pct(o.rateBps)}
                    {o.country ? ` in ${o.country}${o.province ? ` · ${o.province}` : ""}` : " everywhere"}
                  </span>
                  <Button size="sm" variant="ghost" onClick={() => void run(api.DELETE("/api/admin/tax/overrides/{id}", { params: { path: { id: o.id } } }))}>
                    Delete
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
          {collections.length ? (
            <div className="grid gap-2 sm:grid-cols-[1fr_5rem_1fr_6rem_auto] sm:items-end">
              <div className="grid gap-1">
                <Label htmlFor="to-col">Collection</Label>
                <Select id="to-col" value={ov.collectionId} onChange={(e) => setOv({ ...ov, collectionId: e.target.value })}>
                  {collections.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.title}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="grid gap-1">
                <Label htmlFor="to-country">Country</Label>
                <Input id="to-country" maxLength={2} value={ov.country} placeholder="any" onChange={(e) => setOv({ ...ov, country: e.target.value.toUpperCase() })} />
              </div>
              <div className="grid gap-1">
                <Label htmlFor="to-prov">State (optional)</Label>
                <Input id="to-prov" value={ov.province} onChange={(e) => setOv({ ...ov, province: e.target.value })} />
              </div>
              <div className="grid gap-1">
                <Label htmlFor="to-rate">Rate %</Label>
                <Input id="to-rate" inputMode="decimal" value={ov.rate} onChange={(e) => setOv({ ...ov, rate: e.target.value })} />
              </div>
              <Button
                variant="outline"
                disabled={!ov.collectionId || !ov.rate}
                onClick={() => {
                  void run(api.POST("/api/admin/tax/overrides", { body: { collectionId: ov.collectionId, ...(ov.country ? { country: ov.country } : {}), ...(ov.province ? { province: ov.province } : {}), rateBps: toBps(ov.rate) } }));
                  setOv({ ...ov, rate: "" });
                }}
              >
                Add
              </Button>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Create a collection to override its tax rate (for example 5% GST on books).</p>
          )}
        </section>
      </CardContent>
    </Card>
  );
}
