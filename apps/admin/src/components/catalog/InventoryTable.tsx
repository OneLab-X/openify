"use client";
import type { Schemas } from "@shopkit/sdk";
import { Alert, Button, Card, CardContent, CardHeader, CardTitle, Field, Input, Select } from "@shopkit/ui";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, errorMessage } from "@/lib/api-client";

type Location = Schemas["Location"];
type Row = Schemas["InventoryPage"]["items"][number];
type Adjustment = Schemas["InventoryAdjustment"];
const REASONS = ["correction", "received", "cycle_count", "damaged", "theft_or_loss", "promotion", "restock", "other"] as const;

/** Per-location levels with "adjust by" / "set to" edits that write to the adjustment ledger. */
export function InventoryTable({ locations, location, items, nextCursor, q }: { locations: Location[]; location: Location | null; items: Row[]; nextCursor: string | null; q: string }) {
  const router = useRouter();
  const [edits, setEdits] = useState<Record<string, { mode: "delta" | "set"; value: string; quantity: "available" | "incoming" }>>({});
  const [reason, setReason] = useState<(typeof REASONS)[number]>("correction");
  const [note, setNote] = useState("");
  const [history, setHistory] = useState<{ title: string; rows: Adjustment[] } | null>(null);
  const [newLocation, setNewLocation] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function save() {
    if (!location) return;
    const changes = Object.entries(edits)
      .filter(([, e]) => e.value.trim() !== "")
      .map(([inventoryItemId, e]) => ({ inventoryItemId, locationId: location.id, quantity: e.quantity, ...(e.mode === "set" ? { set: Number(e.value) } : { delta: Number(e.value) }) }));
    if (!changes.length) return;
    if (changes.some((c) => !Number.isInteger("set" in c ? c.set : c.delta))) return setMsg({ ok: false, text: "Quantities must be whole numbers" });
    const { error } = await api.POST("/api/admin/inventory/adjustments", { body: { reason, ...(note ? { note } : {}), changes } });
    if (error) return setMsg({ ok: false, text: errorMessage(error) });
    setEdits({});
    setNote("");
    setMsg({ ok: true, text: `Saved ${changes.length} adjustment(s).` });
    router.refresh();
  }

  async function showHistory(r: Row) {
    const { data } = await api.GET("/api/admin/inventory/items/{id}/adjustments", { params: { path: { id: r.inventoryItemId }, query: { limit: 50 } } });
    setHistory({ title: `${r.productTitle} · ${r.variantTitle}`, rows: data ?? [] });
  }

  async function addLocation() {
    const { error } = await api.POST("/api/admin/locations", { body: { name: newLocation } });
    if (error) return setMsg({ ok: false, text: errorMessage(error) });
    setNewLocation("");
    router.refresh();
  }

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-end gap-2">
        <form method="get" className="flex flex-wrap items-end gap-2">
          <Field id="location" label="Location">
            <Select id="location" name="location" defaultValue={location?.id} onChange={(e) => e.currentTarget.form?.requestSubmit()}>
              {locations.map((l) => <option key={l.id} value={l.id}>{l.name}{l.isDefault ? " (default)" : ""}</option>)}
            </Select>
          </Field>
          <Input name="q" type="search" aria-label="Search inventory" placeholder="Product or SKU" defaultValue={q} className="w-56" />
          <Button type="submit" variant="outline">Search</Button>
        </form>
        <div className="ml-auto flex items-end gap-2">
          <Input aria-label="New location name" placeholder="New location" value={newLocation} onChange={(e) => setNewLocation(e.target.value)} className="w-44" />
          <Button variant="outline" disabled={!newLocation.trim()} onClick={() => void addLocation()}>Add location</Button>
        </div>
      </div>
      {msg ? <Alert variant={msg.ok ? "success" : "error"}>{msg.text}</Alert> : null}
      {!location ? (
        <p className="text-sm text-muted-foreground">Add a location to start tracking stock.</p>
      ) : (
        <Card>
          <CardContent className="grid gap-3 pt-6">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-left text-xs text-muted-foreground">
                  <tr><th className="p-2">Product</th><th className="p-2">SKU</th><th className="p-2">Committed</th><th className="p-2">Available</th><th className="p-2">Incoming</th><th className="p-2">Edit</th><th className="p-2" /></tr>
                </thead>
                <tbody>
                  {items.map((r) => {
                    const e = edits[r.inventoryItemId] ?? { mode: "delta" as const, value: "", quantity: "available" as const };
                    const set = (patch: Partial<typeof e>) => setEdits((cur) => ({ ...cur, [r.inventoryItemId]: { ...e, ...patch } }));
                    const name = `${r.productTitle}${r.variantTitle !== "Default Title" ? ` · ${r.variantTitle}` : ""}`;
                    return (
                      <tr key={r.inventoryItemId} className="border-t border-border">
                        <td className="p-2"><Link href={`/products/${r.productId}`} className="hover:underline">{name}</Link>{!r.tracked ? <span className="ml-2 text-xs text-muted-foreground">not tracked</span> : null}</td>
                        <td className="p-2">{r.sku ?? ""}</td>
                        <td className="p-2">{r.committed}</td>
                        <td className="p-2 font-medium">{r.available}</td>
                        <td className="p-2">{r.incoming}</td>
                        <td className="p-2">
                          <div className="flex gap-1">
                            <Select aria-label={`Quantity to edit for ${name}`} value={e.quantity} onChange={(ev) => set({ quantity: ev.target.value as "available" | "incoming" })} className="h-8 w-28">
                              <option value="available">Available</option>
                              <option value="incoming">Incoming</option>
                            </Select>
                            <Select aria-label={`Edit mode for ${name}`} value={e.mode} onChange={(ev) => set({ mode: ev.target.value as "delta" | "set" })} className="h-8 w-24">
                              <option value="delta">Adjust by</option>
                              <option value="set">Set to</option>
                            </Select>
                            <Input aria-label={`Change for ${name}`} inputMode="numeric" value={e.value} onChange={(ev) => set({ value: ev.target.value })} className="h-8 w-20" />
                          </div>
                        </td>
                        <td className="p-2"><Button size="sm" variant="ghost" onClick={() => void showHistory(r)}>History</Button></td>
                      </tr>
                    );
                  })}
                  {items.length === 0 ? <tr><td colSpan={7} className="p-6 text-center text-muted-foreground">No variants at this location.</td></tr> : null}
                </tbody>
              </table>
            </div>
            <div className="flex flex-wrap items-end gap-2">
              <Field id="reason" label="Reason">
                <Select id="reason" value={reason} onChange={(e) => setReason(e.target.value as (typeof REASONS)[number])}>
                  {REASONS.map((r) => <option key={r} value={r}>{r.replace(/_/g, " ")}</option>)}
                </Select>
              </Field>
              <Field id="note" label="Note" className="w-64"><Input id="note" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
              <Button onClick={() => void save()} disabled={!Object.values(edits).some((e) => e.value.trim())}>Save adjustments</Button>
            </div>
            {nextCursor ? <Link href={`/inventory?location=${location.id}&cursor=${encodeURIComponent(nextCursor)}${q ? `&q=${encodeURIComponent(q)}` : ""}`} className="justify-self-center text-sm underline">Next page</Link> : null}
          </CardContent>
        </Card>
      )}
      {history ? (
        <Card>
          <CardHeader className="flex-row items-center justify-between">
            <CardTitle>History · {history.title}</CardTitle>
            <Button variant="ghost" size="sm" onClick={() => setHistory(null)}>Close</Button>
          </CardHeader>
          <CardContent>
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted-foreground"><tr><th className="p-2">When</th><th className="p-2">Location</th><th className="p-2">Quantity</th><th className="p-2">Change</th><th className="p-2">After</th><th className="p-2">Reason</th></tr></thead>
              <tbody>
                {history.rows.map((a) => (
                  <tr key={a.id} className="border-t border-border">
                    <td className="p-2">{new Date(a.createdAt).toLocaleString()}</td>
                    <td className="p-2">{a.locationName}</td>
                    <td className="p-2">{a.quantity}</td>
                    <td className="p-2">{a.delta > 0 ? `+${a.delta}` : a.delta}</td>
                    <td className="p-2">{a.quantityAfter}</td>
                    <td className="p-2">{a.reason.replace(/_/g, " ")}{a.note ? ` · ${a.note}` : ""}</td>
                  </tr>
                ))}
                {history.rows.length === 0 ? <tr><td colSpan={6} className="p-4 text-center text-muted-foreground">No changes yet.</td></tr> : null}
              </tbody>
            </table>
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
