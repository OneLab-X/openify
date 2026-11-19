"use client";
import type { Schemas } from "@shopkit/sdk";
import { Alert, Button, Card, CardContent, CardHeader, CardTitle, Checkbox, Field, Input, Select, Textarea } from "@shopkit/ui";
import { Plus, Trash2, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, errorMessage, type JsonBody } from "@/lib/api-client";
import { uploadImage, type Media } from "@/lib/media-upload";
import { fromInput, toInput } from "@/lib/money";
import { RichTextEditor } from "./RichTextEditor";
import { SortableList } from "./Sortable";

type Collection = Schemas["CollectionAdmin"];
type ProductRef = Collection["products"][number];
type Body = JsonBody<"/api/admin/collections", "post">;
type Rule = { key: string; field: string; relation: string; value: string };

const FIELDS: Record<string, { label: string; relations: string[]; money?: boolean }> = {
  tag: { label: "Product tag", relations: ["equals", "not_equals"] },
  title: { label: "Product title", relations: ["equals", "not_equals", "starts_with", "ends_with", "contains", "not_contains"] },
  type: { label: "Product type", relations: ["equals", "not_equals", "starts_with", "ends_with", "contains", "not_contains"] },
  vendor: { label: "Product vendor", relations: ["equals", "not_equals", "starts_with", "ends_with", "contains", "not_contains"] },
  price: { label: "Price", relations: ["greater_than", "less_than", "equals", "not_equals"], money: true },
  compare_at_price: { label: "Compare-at price", relations: ["greater_than", "less_than", "equals", "not_equals"], money: true },
  inventory: { label: "Inventory stock", relations: ["greater_than", "less_than", "equals", "not_equals"] },
};
const RELATION_LABEL: Record<string, string> = {
  equals: "is equal to",
  not_equals: "is not equal to",
  starts_with: "starts with",
  ends_with: "ends with",
  contains: "contains",
  not_contains: "does not contain",
  greater_than: "is greater than",
  less_than: "is less than",
};
const SORTS: [string, string][] = [
  ["manual", "Manually"],
  ["best_selling", "Best selling"],
  ["title_asc", "Product title A–Z"],
  ["title_desc", "Product title Z–A"],
  ["price_desc", "Highest price"],
  ["price_asc", "Lowest price"],
  ["created_desc", "Newest"],
  ["created_asc", "Oldest"],
];

export function CollectionEditor({ collection, currency, flash }: { collection: Collection | null; currency: string; flash?: string }) {
  const router = useRouter();
  const [title, setTitle] = useState(collection?.title ?? "");
  const [handle, setHandle] = useState(collection?.handle ?? "");
  const [description, setDescription] = useState(collection?.descriptionHtml ?? "");
  const [type, setType] = useState<"manual" | "smart">(collection?.type ?? "manual");
  const [match, setMatch] = useState<"all" | "any">(collection?.rules?.match ?? "all");
  const [rules, setRules] = useState<Rule[]>(
    collection?.rules?.conditions.map((c, i) => ({ key: `r${i}`, ...c, value: FIELDS[c.field]?.money ? toInput(Number(c.value), currency) : c.value })) ?? [
      { key: "r0", field: "tag", relation: "equals", value: "" },
    ],
  );
  const [sortOrder, setSortOrder] = useState(collection?.sortOrder ?? "best_selling");
  const [products, setProducts] = useState<ProductRef[]>(collection?.products ?? []);
  const [image, setImage] = useState<Media | null>(collection?.image ?? null);
  const [seoTitle, setSeoTitle] = useState(collection?.seoTitle ?? "");
  const [seoDescription, setSeoDescription] = useState(collection?.seoDescription ?? "");
  const [published, setPublished] = useState(collection?.published ?? true);
  const [search, setSearch] = useState("");
  const [results, setResults] = useState<ProductRef[]>([]);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(flash ? { ok: true, text: flash } : null);

  async function find() {
    const { data } = await api.GET("/api/admin/products", { params: { query: { q: search, limit: 20 } } });
    setResults((data?.items ?? []).filter((p) => !products.some((x) => x.id === p.id)).map((p) => ({ id: p.id, title: p.title, handle: p.handle, status: p.status, image: p.image })));
  }

  function body(): Body | string {
    const conditions: NonNullable<Body["rules"]>["conditions"] = [];
    for (const r of rules) {
      const spec = FIELDS[r.field]!;
      let value = r.value.trim();
      if (!value) return "Fill in every condition";
      if (spec.money) {
        const minor = fromInput(value, currency);
        if (minor === null || Number.isNaN(minor)) return `${spec.label} must be an amount`;
        value = String(minor);
      }
      conditions.push({ field: r.field, relation: r.relation, value } as never);
    }
    return {
      title,
      ...(handle.trim() ? { handle } : {}),
      descriptionHtml: description,
      type,
      sortOrder: sortOrder as Body["sortOrder"],
      imageMediaId: image?.id ?? null,
      seoTitle: seoTitle || null,
      seoDescription: seoDescription || null,
      published,
      ...(type === "smart" ? { rules: { match, conditions } } : { productIds: products.map((p) => p.id) }),
    };
  }

  async function save() {
    const b = body();
    if (typeof b === "string") return setMsg({ ok: false, text: b });
    setSaving(true);
    const res = collection
      ? await api.PUT("/api/admin/collections/{id}", { params: { path: { id: collection.id } }, body: b })
      : await api.POST("/api/admin/collections", { body: b });
    setSaving(false);
    if (!res.data) return setMsg({ ok: false, text: errorMessage(res.error) });
    setMsg({ ok: true, text: `Collection saved (${res.data.productsCount} products).` });
    if (!collection) router.replace(`/collections/${res.data.id}?saved=1`);
    else router.refresh();
  }

  async function remove() {
    if (!collection || !window.confirm(`Delete “${collection.title}”? Products are not deleted.`)) return;
    const { error } = await api.DELETE("/api/admin/collections/{id}", { params: { path: { id: collection.id } } });
    if (error) setMsg({ ok: false, text: errorMessage(error) });
    else router.replace("/collections");
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_320px]">
      <div className="grid content-start gap-6">
        <Card>
          <CardContent className="grid gap-4 pt-6">
            <Field id="title" label="Title" required>
              <Input id="title" value={title} onChange={(e) => setTitle(e.target.value)} />
            </Field>
            <div className="grid gap-1.5">
              <span id="cdesc-label" className="text-sm font-medium">Description</span>
              <RichTextEditor id="cdesc" labelledBy="cdesc-label" value={description} onChange={setDescription} />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Collection type</CardTitle></CardHeader>
          <CardContent className="grid gap-4">
            <fieldset className="grid gap-2 text-sm" disabled={!!collection}>
              <legend className="sr-only">Collection type</legend>
              <label className="flex items-center gap-2"><input type="radio" name="ctype" checked={type === "manual"} onChange={() => setType("manual")} /> Manual — pick products one by one</label>
              <label className="flex items-center gap-2"><input type="radio" name="ctype" checked={type === "smart"} onChange={() => { setType("smart"); if (sortOrder === "manual") setSortOrder("best_selling"); }} /> Automated — products matching conditions</label>
            </fieldset>

            {type === "smart" ? (
              <div className="grid gap-3">
                <div className="flex items-center gap-3 text-sm">
                  Products must match:
                  <label className="flex items-center gap-1"><input type="radio" name="match" checked={match === "all"} onChange={() => setMatch("all")} /> all conditions</label>
                  <label className="flex items-center gap-1"><input type="radio" name="match" checked={match === "any"} onChange={() => setMatch("any")} /> any condition</label>
                </div>
                {rules.map((r, i) => {
                  const spec = FIELDS[r.field]!;
                  return (
                    <div key={r.key} className="grid grid-cols-[1fr_1fr_1fr_auto] gap-2">
                      <Select aria-label={`Condition ${i + 1} field`} value={r.field} onChange={(e) => setRules((cur) => cur.map((x) => (x.key === r.key ? { ...x, field: e.target.value, relation: FIELDS[e.target.value]!.relations[0]! } : x)))}>
                        {Object.entries(FIELDS).map(([k, f]) => <option key={k} value={k}>{f.label}</option>)}
                      </Select>
                      <Select aria-label={`Condition ${i + 1} relation`} value={r.relation} onChange={(e) => setRules((cur) => cur.map((x) => (x.key === r.key ? { ...x, relation: e.target.value } : x)))}>
                        {spec.relations.map((rel) => <option key={rel} value={rel}>{RELATION_LABEL[rel]}</option>)}
                      </Select>
                      <Input aria-label={`Condition ${i + 1} value`} inputMode={spec.money || r.field === "inventory" ? "decimal" : undefined} value={r.value} onChange={(e) => setRules((cur) => cur.map((x) => (x.key === r.key ? { ...x, value: e.target.value } : x)))} />
                      <Button variant="ghost" size="icon" aria-label={`Remove condition ${i + 1}`} disabled={rules.length === 1} onClick={() => setRules((cur) => cur.filter((x) => x.key !== r.key))}><Trash2 className="h-4 w-4" /></Button>
                    </div>
                  );
                })}
                <Button variant="outline" className="justify-self-start" onClick={() => setRules((cur) => [...cur, { key: crypto.randomUUID(), field: "tag", relation: "equals", value: "" }])}>
                  <Plus className="h-4 w-4" /> Add condition
                </Button>
              </div>
            ) : null}
          </CardContent>
        </Card>

        {type === "manual" ? (
          <Card>
            <CardHeader><CardTitle>Products ({products.length})</CardTitle></CardHeader>
            <CardContent className="grid gap-3">
              <div className="flex gap-2">
                <Input aria-label="Search products to add" placeholder="Search products" value={search} onChange={(e) => setSearch(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void find(); } }} />
                <Button variant="outline" onClick={() => void find()}>Browse</Button>
              </div>
              {results.length ? (
                <ul className="grid gap-1 rounded-md border border-border p-2 text-sm" aria-label="Search results">
                  {results.map((p) => (
                    <li key={p.id} className="flex items-center justify-between">
                      {p.title}
                      <Button size="sm" variant="ghost" onClick={() => { setProducts((cur) => [...cur, p]); setResults((cur) => cur.filter((x) => x.id !== p.id)); }}>Add</Button>
                    </li>
                  ))}
                </ul>
              ) : null}
              <SortableList
                items={products}
                onChange={setProducts}
                className="grid gap-1"
                render={(p, grip, i) => (
                  <div className="flex items-center gap-2 rounded-md border border-border px-2 py-1 text-sm">
                    {sortOrder === "manual" ? grip : <span className="w-6 text-center text-muted-foreground">{i + 1}</span>}
                    {p.image ? <img src={p.image.url} alt="" className="h-8 w-8 rounded object-cover" /> : null}
                    <span className="flex-1">{p.title}</span>
                    <button type="button" aria-label={`Remove ${p.title}`} onClick={() => setProducts((cur) => cur.filter((x) => x.id !== p.id))}><X className="h-4 w-4" /></button>
                  </div>
                )}
              />
            </CardContent>
          </Card>
        ) : collection ? (
          <Card>
            <CardHeader><CardTitle>Matching products ({collection.productsCount})</CardTitle></CardHeader>
            <CardContent>
              <ul className="grid gap-1 text-sm">{collection.products.map((p) => <li key={p.id}>{p.title}</li>)}</ul>
            </CardContent>
          </Card>
        ) : null}
      </div>

      <div className="grid content-start gap-6">
        <Card>
          <CardContent className="grid gap-4 pt-6">
            <label className="flex items-center gap-2 text-sm"><Checkbox checked={published} onChange={(e) => setPublished(e.target.checked)} /> Visible on the storefront</label>
            <Field id="sortOrder" label="Sort products">
              <Select id="sortOrder" value={sortOrder} onChange={(e) => setSortOrder(e.target.value as typeof sortOrder)}>
                {SORTS.filter(([k]) => type === "manual" || k !== "manual").map(([k, l]) => <option key={k} value={k}>{l}</option>)}
              </Select>
            </Field>
            <Button onClick={() => void save()} loading={saving} disabled={saving}>Save collection</Button>
            {msg ? <Alert variant={msg.ok ? "success" : "error"}>{msg.text}</Alert> : null}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Image</CardTitle></CardHeader>
          <CardContent className="grid gap-2">
            {image ? <img src={image.url} alt={image.alt ?? ""} className="aspect-video w-full rounded object-cover" /> : null}
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp,image/avif"
              aria-label="Collection image"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                try {
                  setImage(await uploadImage(f));
                } catch (err) {
                  setMsg({ ok: false, text: (err as Error).message });
                }
              }}
            />
            {image ? <Button variant="ghost" size="sm" className="justify-self-start" onClick={() => setImage(null)}>Remove image</Button> : null}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Search engine listing</CardTitle></CardHeader>
          <CardContent className="grid gap-4">
            <Field id="chandle" label="URL handle" description={handle ? `/collections/${handle}` : "Generated from the title"}>
              <Input id="chandle" value={handle} onChange={(e) => setHandle(e.target.value)} />
            </Field>
            <Field id="cseoTitle" label="Page title"><Input id="cseoTitle" value={seoTitle} onChange={(e) => setSeoTitle(e.target.value)} /></Field>
            <Field id="cseoDesc" label="Meta description"><Textarea id="cseoDesc" value={seoDescription} onChange={(e) => setSeoDescription(e.target.value)} /></Field>
          </CardContent>
        </Card>
        {collection ? <Button variant="destructive" onClick={() => void remove()}>Delete collection</Button> : null}
      </div>
    </div>
  );
}
