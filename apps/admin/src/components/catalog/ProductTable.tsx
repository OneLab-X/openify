"use client";
import type { Schemas } from "@shopkit/sdk";
import { Alert, Badge, Button, Card, CardContent, Input, Select } from "@shopkit/ui";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";
import { api, errorMessage, type JsonBody } from "@/lib/api-client";
import { formatMoney } from "@/lib/money";

type Item = Schemas["ProductList"]["items"][number];
type View = Schemas["SavedView"];
type Filters = Record<string, string>;

const STATUS_BADGE: Record<Item["status"], "success" | "secondary" | "outline"> = { active: "success", draft: "secondary", archived: "outline" };

/** Product list with GET-form filters, saved views and bulk actions (edit/archive/tag/delete). */
export function ProductTable({ items, nextCursor, filters, views, facets }: { items: Item[]; nextCursor: string | null; filters: Filters; views: View[]; facets: Schemas["CatalogFacets"] }) {
  const router = useRouter();
  const path = usePathname();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [bulkTag, setBulkTag] = useState("");
  const all = items.length > 0 && items.every((i) => selected.has(i.id));
  const qs = (f: Record<string, unknown>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(f)) if (typeof v === "string" && v) p.set(k, v);
    const s = p.toString();
    return s ? `${path}?${s}` : path;
  };

  async function bulk(action: JsonBody<"/api/admin/products/bulk", "post">["action"], confirmText?: string) {
    if (!selected.size || (confirmText && !window.confirm(confirmText))) return;
    setBusy(true);
    const { data, error } = await api.POST("/api/admin/products/bulk", { body: { ids: [...selected], action } });
    setBusy(false);
    setMsg(data ? { ok: true, text: `Updated ${data.updated} product(s).` } : { ok: false, text: errorMessage(error) });
    if (data) {
      setSelected(new Set());
      router.refresh();
    }
  }

  async function saveView() {
    const name = window.prompt("Name this view");
    if (!name) return;
    const { error } = await api.POST("/api/admin/product-views", { body: { name, filters } });
    if (error) setMsg({ ok: false, text: errorMessage(error) });
    else router.refresh();
  }

  return (
    <div className="grid gap-4">
      <nav aria-label="Saved views" className="flex flex-wrap items-center gap-2 text-sm">
        <Link href={path} className="rounded-full border border-border px-3 py-1 hover:bg-muted">All</Link>
        {(["active", "draft", "archived"] as const).map((s) => (
          <Link key={s} href={qs({ status: s })} aria-current={filters.status === s && Object.keys(filters).length === 1 ? "page" : undefined} className="rounded-full border border-border px-3 py-1 capitalize hover:bg-muted aria-[current=page]:bg-muted">
            {s}
          </Link>
        ))}
        {views.map((v) => (
          <span key={v.id} className="inline-flex items-center rounded-full border border-border">
            <Link href={qs(v.filters)} className="py-1 pl-3 pr-1 hover:underline">{v.name}</Link>
            <button
              type="button"
              aria-label={`Delete view ${v.name}`}
              className="px-2 text-muted-foreground"
              onClick={async () => {
                await api.DELETE("/api/admin/product-views/{id}", { params: { path: { id: v.id } } });
                router.refresh();
              }}
            >
              ×
            </button>
          </span>
        ))}
        <Button variant="ghost" size="sm" onClick={() => void saveView()}>Save view</Button>
      </nav>

      <Card>
        <CardContent className="grid gap-4 pt-6">
          <form method="get" className="flex flex-wrap items-end gap-2" aria-label="Filter products">
            <Input name="q" type="search" aria-label="Search products" placeholder="Search title, SKU, tag…" defaultValue={filters.q ?? ""} className="w-64" />
            <Select name="status" aria-label="Status" defaultValue={filters.status ?? ""} className="w-36">
              <option value="">Any status</option>
              <option value="active">Active</option>
              <option value="draft">Draft</option>
              <option value="archived">Archived</option>
            </Select>
            <Select name="vendor" aria-label="Vendor" defaultValue={filters.vendor ?? ""} className="w-40">
              <option value="">Any vendor</option>
              {facets.vendors.map((v) => <option key={v} value={v}>{v}</option>)}
            </Select>
            <Select name="productType" aria-label="Product type" defaultValue={filters.productType ?? ""} className="w-40">
              <option value="">Any type</option>
              {facets.productTypes.map((v) => <option key={v} value={v}>{v}</option>)}
            </Select>
            <Select name="tag" aria-label="Tag" defaultValue={filters.tag ?? ""} className="w-40">
              <option value="">Any tag</option>
              {facets.tags.map((v) => <option key={v} value={v}>{v}</option>)}
            </Select>
            <Select name="availability" aria-label="Availability" defaultValue={filters.availability ?? ""} className="w-36">
              <option value="">Any stock</option>
              <option value="in_stock">In stock</option>
              <option value="out_of_stock">Out of stock</option>
            </Select>
            <Select name="sort" aria-label="Sort" defaultValue={filters.sort ?? "updated_desc"} className="w-44">
              <option value="updated_desc">Recently updated</option>
              <option value="created_desc">Newest</option>
              <option value="title_asc">Title A–Z</option>
              <option value="title_desc">Title Z–A</option>
              <option value="price_asc">Price, low to high</option>
              <option value="price_desc">Price, high to low</option>
              <option value="inventory_asc">Inventory, low to high</option>
              <option value="inventory_desc">Inventory, high to low</option>
            </Select>
            <Button type="submit" variant="outline">Filter</Button>
          </form>

          {selected.size ? (
            <div className="flex flex-wrap items-center gap-2 rounded-md bg-muted p-2 text-sm" role="region" aria-label="Bulk actions">
              <span>{selected.size} selected</span>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void bulk({ type: "set_status", status: "active" })}>Set active</Button>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void bulk({ type: "set_status", status: "draft" })}>Set draft</Button>
              <Button size="sm" variant="outline" disabled={busy} onClick={() => void bulk({ type: "set_status", status: "archived" })}>Archive</Button>
              <Input aria-label="Tags to add or remove" placeholder="tag, tag" value={bulkTag} onChange={(e) => setBulkTag(e.target.value)} className="h-8 w-40" />
              <Button size="sm" variant="outline" disabled={busy || !bulkTag.trim()} onClick={() => void bulk({ type: "add_tags", tags: bulkTag.split(",").map((t) => t.trim()).filter(Boolean) })}>Add tags</Button>
              <Button size="sm" variant="outline" disabled={busy || !bulkTag.trim()} onClick={() => void bulk({ type: "remove_tags", tags: bulkTag.split(",").map((t) => t.trim()).filter(Boolean) })}>Remove tags</Button>
              <Button size="sm" variant="destructive" disabled={busy} onClick={() => void bulk({ type: "delete" }, `Delete ${selected.size} product(s)? This cannot be undone.`)}>Delete</Button>
            </div>
          ) : null}
          {msg ? <Alert variant={msg.ok ? "success" : "error"}>{msg.text}</Alert> : null}

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr>
                  <th className="w-8 p-2">
                    <input type="checkbox" aria-label="Select all products" checked={all} onChange={(e) => setSelected(e.target.checked ? new Set(items.map((i) => i.id)) : new Set())} />
                  </th>
                  <th className="p-2">Product</th>
                  <th className="p-2">Status</th>
                  <th className="p-2">Inventory</th>
                  <th className="p-2">Price</th>
                  <th className="p-2">Type</th>
                  <th className="p-2">Vendor</th>
                </tr>
              </thead>
              <tbody>
                {items.map((p) => (
                  <tr key={p.id} className="border-t border-border">
                    <td className="p-2">
                      <input
                        type="checkbox"
                        aria-label={`Select ${p.title}`}
                        checked={selected.has(p.id)}
                        onChange={(e) =>
                          setSelected((cur) => {
                            const next = new Set(cur);
                            if (e.target.checked) next.add(p.id);
                            else next.delete(p.id);
                            return next;
                          })
                        }
                      />
                    </td>
                    <td className="p-2">
                      <Link href={`/products/${p.id}`} className="flex items-center gap-3 font-medium hover:underline">
                        {p.image ? <img src={p.image.sources.find((s) => s.format === "webp")?.url ?? p.image.url} alt="" className="h-10 w-10 rounded object-cover" /> : <span className="h-10 w-10 rounded bg-muted" />}
                        {p.title}
                      </Link>
                    </td>
                    <td className="p-2"><Badge variant={STATUS_BADGE[p.status]} className="capitalize">{p.status}</Badge></td>
                    <td className="p-2">{p.totalInventory} in stock{p.variantsCount > 1 ? ` · ${p.variantsCount} variants` : ""}</td>
                    <td className="p-2">{formatMoney(p.priceMin, p.currency)}{p.priceMax !== p.priceMin ? ` – ${formatMoney(p.priceMax, p.currency)}` : ""}</td>
                    <td className="p-2">{p.productType ?? ""}</td>
                    <td className="p-2">{p.vendor ?? ""}</td>
                  </tr>
                ))}
                {items.length === 0 ? (
                  <tr><td colSpan={7} className="p-6 text-center text-muted-foreground">No products match. <Link className="text-primary underline" href="/products/new">Add a product</Link></td></tr>
                ) : null}
              </tbody>
            </table>
          </div>
          {nextCursor ? (
            <Link href={qs({ ...filters, cursor: nextCursor })} className="justify-self-center rounded-md border border-input px-4 py-2 text-sm hover:bg-muted">Next page</Link>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
