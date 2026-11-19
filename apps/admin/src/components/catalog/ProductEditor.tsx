"use client";
import type { Schemas } from "@shopkit/sdk";
import { Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle, Checkbox, Field, Input, Select, Textarea } from "@shopkit/ui";
import { ImagePlus, Plus, Trash2, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { api, errorMessage, type JsonBody } from "@/lib/api-client";
import { uploadImage, type Media } from "@/lib/media-upload";
import { fromInput, toInput } from "@/lib/money";
import { RichTextEditor } from "./RichTextEditor";
import { SortableList } from "./Sortable";

type Product = Schemas["ProductAdmin"];
type Location = Schemas["Location"];
type ProductInput = JsonBody<"/api/admin/products", "post">;

interface OptionDraft {
  name: string;
  values: string[];
  pending: string;
}
interface VariantDraft {
  id?: string;
  price: string;
  compareAtPrice: string;
  cost: string;
  sku: string;
  barcode: string;
  weight: string;
  requiresShipping: boolean;
  taxable: boolean;
  hsnCode: string;
  inventoryPolicy: "deny" | "continue";
  tracked: boolean;
  imageMediaId: string | null;
  quantity: string;
  quantityTouched: boolean;
}
interface MetaDraft {
  key: string;
  namespace: string;
  field: string;
  type: string;
  value: string;
}

const METAFIELD_TYPES = ["single_line_text", "multi_line_text", "number_integer", "number_decimal", "boolean", "url", "date", "json"];
const keyOf = (values: string[]) => JSON.stringify(values.map((v) => v.toLowerCase()));

function cartesian(options: OptionDraft[]): string[][] {
  const usable = options.filter((o) => o.name.trim() && o.values.length);
  return usable.reduce<string[][]>((acc, o) => acc.flatMap((combo) => o.values.map((v) => [...combo, v])), [[]]);
}

export function ProductEditor({
  product,
  currency,
  weightUnit,
  locations,
  facets,
}: {
  product: Product | null;
  currency: string;
  weightUnit: "kg" | "g" | "lb" | "oz";
  locations: Location[];
  facets: Schemas["CatalogFacets"];
}) {
  const router = useRouter();
  const defaultLocation = locations.find((l) => l.isDefault) ?? locations[0];
  const [title, setTitle] = useState(product?.title ?? "");
  const [handle, setHandle] = useState(product?.handle ?? "");
  const [description, setDescription] = useState(product?.descriptionHtml ?? "");
  const [status, setStatus] = useState<Product["status"]>(product?.status ?? "draft");
  const [vendor, setVendor] = useState(product?.vendor ?? "");
  const [productType, setProductType] = useState(product?.productType ?? "");
  const [tags, setTags] = useState(product?.tags.join(", ") ?? "");
  const [seoTitle, setSeoTitle] = useState(product?.seoTitle ?? "");
  const [seoDescription, setSeoDescription] = useState(product?.seoDescription ?? "");
  const [options, setOptions] = useState<OptionDraft[]>(product?.options.map((o) => ({ name: o.name, values: o.values, pending: "" })) ?? []);
  const [media, setMedia] = useState<Media[]>(product?.media ?? []);
  const [uploading, setUploading] = useState(0);
  const [meta, setMeta] = useState<MetaDraft[]>(
    product?.metafields.map((m, i) => ({ key: `m${i}`, namespace: m.namespace, field: m.key, type: m.type, value: typeof m.value === "string" ? m.value : JSON.stringify(m.value) })) ?? [],
  );
  const [rows, setRows] = useState<Record<string, VariantDraft>>(() => {
    const out: Record<string, VariantDraft> = {};
    for (const v of product?.variants ?? []) {
      const level = v.inventory.find((l) => l.locationId === defaultLocation?.id);
      out[keyOf(v.options)] = {
        id: v.id,
        price: toInput(v.price, currency),
        compareAtPrice: toInput(v.compareAtPrice, currency),
        cost: toInput(v.cost, currency),
        sku: v.sku ?? "",
        barcode: v.barcode ?? "",
        weight: v.weight === null ? "" : String(v.weight),
        requiresShipping: v.requiresShipping,
        taxable: v.taxable,
        hsnCode: v.hsnCode ?? "",
        inventoryPolicy: v.inventoryPolicy,
        tracked: v.tracked,
        imageMediaId: v.imageMediaId,
        quantity: String(level?.available ?? 0),
        quantityTouched: false,
      };
    }
    return out;
  });
  const [bulkPrice, setBulkPrice] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string; details?: string[] } | null>(null);

  const combos = useMemo(() => cartesian(options), [options]);
  const blank = (): VariantDraft => {
    const first = Object.values(rows)[0];
    return {
      price: first?.price ?? "",
      compareAtPrice: "",
      cost: "",
      sku: "",
      barcode: "",
      weight: first?.weight ?? "",
      requiresShipping: first?.requiresShipping ?? true,
      taxable: first?.taxable ?? true,
      hsnCode: first?.hsnCode ?? "",
      inventoryPolicy: "deny",
      tracked: first?.tracked ?? true,
      imageMediaId: null,
      quantity: "0",
      quantityTouched: false,
    };
  };
  const rowFor = (combo: string[]) => rows[keyOf(combo)] ?? blank();
  const patch = (combo: string[], change: Partial<VariantDraft>) => setRows((r) => ({ ...r, [keyOf(combo)]: { ...rowFor(combo), ...change } }));
  const label = (combo: string[]) => (combo.length ? combo.join(" / ") : "Default");

  function addValue(i: number) {
    setOptions((opts) =>
      opts.map((o, j) => {
        if (j !== i) return o;
        const vals = o.pending
          .split(",")
          .map((v) => v.trim())
          .filter((v) => v && !o.values.some((x) => x.toLowerCase() === v.toLowerCase()));
        return { ...o, values: [...o.values, ...vals], pending: "" };
      }),
    );
  }

  async function onFiles(files: FileList | null) {
    if (!files?.length) return;
    setMsg(null);
    const list = [...files];
    setUploading((n) => n + list.length);
    for (const file of list) {
      try {
        const m = await uploadImage(file);
        setMedia((cur) => [...cur, m]);
      } catch (err) {
        setMsg({ ok: false, text: `${file.name}: ${(err as Error).message}` });
      } finally {
        setUploading((n) => n - 1);
      }
    }
  }

  async function saveAlt(m: Media, alt: string) {
    if ((m.alt ?? "") === alt) return;
    const { data, error } = await api.PATCH("/api/admin/media/{id}", { params: { path: { id: m.id } }, body: { alt: alt || null } });
    if (data) setMedia((cur) => cur.map((x) => (x.id === m.id ? data : x)));
    else setMsg({ ok: false, text: errorMessage(error) });
  }

  function build(): ProductInput | string {
    const variants: ProductInput["variants"] = [];
    for (const combo of combos) {
      const r = rowFor(combo);
      const price = fromInput(r.price, currency);
      const compareAtPrice = fromInput(r.compareAtPrice, currency);
      const cost = fromInput(r.cost, currency);
      if (price === null || Number.isNaN(price)) return `Enter a price for ${label(combo)}`;
      if (Number.isNaN(compareAtPrice) || Number.isNaN(cost)) return `Check the prices of ${label(combo)}`;
      const quantity = Number(r.quantity);
      if (r.quantityTouched && !Number.isInteger(quantity)) return `Quantity for ${label(combo)} must be a whole number`;
      variants.push({
        ...(r.id ? { id: r.id } : {}),
        options: combo,
        price,
        compareAtPrice,
        cost,
        sku: r.sku || null,
        barcode: r.barcode || null,
        weight: r.weight === "" ? null : Number(r.weight),
        weightUnit,
        requiresShipping: r.requiresShipping,
        taxable: r.taxable,
        hsnCode: r.hsnCode || null,
        inventoryPolicy: r.inventoryPolicy,
        tracked: r.tracked,
        imageMediaId: r.imageMediaId && media.some((m) => m.id === r.imageMediaId) ? r.imageMediaId : null,
        ...(r.quantityTouched && r.tracked ? { inventory: [{ ...(defaultLocation ? { locationId: defaultLocation.id } : {}), available: quantity }] } : {}),
      });
    }
    return {
      title,
      ...(handle.trim() ? { handle } : {}),
      descriptionHtml: description,
      status,
      vendor: vendor || null,
      productType: productType || null,
      tags: tags.split(",").map((t) => t.trim()).filter(Boolean),
      seoTitle: seoTitle || null,
      seoDescription: seoDescription || null,
      options: options.filter((o) => o.name.trim() && o.values.length).map((o) => ({ name: o.name.trim(), values: o.values })),
      variants,
      mediaIds: media.map((m) => m.id),
      metafields: meta.filter((m) => m.namespace && m.field).map((m) => ({ namespace: m.namespace, key: m.field, type: m.type as "json", value: m.type === "json" ? safeJson(m.value) : m.value })),
    };
  }

  async function save() {
    const body = build();
    if (typeof body === "string") {
      setMsg({ ok: false, text: body });
      return;
    }
    setSaving(true);
    setMsg(null);
    const res = product
      ? await api.PUT("/api/admin/products/{id}", { params: { path: { id: product.id } }, body })
      : await api.POST("/api/admin/products", { body });
    setSaving(false);
    if (!res.data) {
      const details = (res.error as { error?: { details?: { path?: string; message: string }[] } } | undefined)?.error?.details;
      setMsg({ ok: false, text: errorMessage(res.error), ...(details ? { details: details.map((d) => (d.path ? `${d.path}: ${d.message}` : d.message)) } : {}) });
      return;
    }
    setMsg({ ok: true, text: "Product saved." });
    if (!product) router.replace(`/products/${res.data.id}`);
    else {
      setHandle(res.data.handle);
      setRows((r) => {
        const next = { ...r };
        for (const v of res.data.variants) next[keyOf(v.options)] = { ...(next[keyOf(v.options)] ?? blank()), id: v.id, quantityTouched: false };
        return next;
      });
      router.refresh();
    }
  }

  async function remove() {
    if (!product || !window.confirm(`Delete “${product.title}”? This cannot be undone.`)) return;
    const { error } = await api.DELETE("/api/admin/products/{id}", { params: { path: { id: product.id } } });
    if (error) setMsg({ ok: false, text: errorMessage(error) });
    else router.replace("/products");
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
              <span id="description-label" className="text-sm font-medium">Description</span>
              <RichTextEditor id="description" labelledBy="description-label" value={description} onChange={setDescription} />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Media</CardTitle></CardHeader>
          <CardContent className="grid gap-3">
            <SortableList
              items={media}
              onChange={setMedia}
              layout="grid"
              className="grid grid-cols-2 gap-3 sm:grid-cols-4"
              render={(m, handleEl, i) => (
                <div className="grid gap-1 rounded-md border border-border p-2">
                  <div className="flex items-center justify-between">
                    {handleEl}
                    {i === 0 ? <Badge variant="secondary">Cover</Badge> : null}
                    <button type="button" aria-label={`Remove image ${i + 1}`} className="rounded p-1 hover:bg-muted" onClick={() => setMedia((cur) => cur.filter((x) => x.id !== m.id))}>
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                  <img src={m.sources.find((s) => s.format === "webp" && s.width >= 320)?.url ?? m.url} alt={m.alt ?? ""} className="aspect-square w-full rounded object-cover" />
                  <Input aria-label={`Alt text for image ${i + 1}`} defaultValue={m.alt ?? ""} placeholder="Alt text" onBlur={(e) => void saveAlt(m, e.target.value.trim())} className="h-8 text-xs" />
                </div>
              )}
            />
            <label className="flex cursor-pointer items-center gap-2 justify-self-start rounded-md border border-dashed border-input px-4 py-3 text-sm hover:bg-muted">
              <ImagePlus className="h-4 w-4" aria-hidden /> Add images
              <input type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/avif" multiple className="sr-only" aria-label="Add images" onChange={(e) => void onFiles(e.target.files)} />
            </label>
            {uploading ? <p className="text-sm text-muted-foreground" role="status">Uploading {uploading} image(s)…</p> : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Options</CardTitle></CardHeader>
          <CardContent className="grid gap-4">
            {options.map((o, i) => (
              <div key={i} className="grid gap-2 rounded-md border border-border p-3">
                <div className="flex items-end gap-2">
                  <Field id={`option-${i}-name`} label={`Option ${i + 1} name`} className="flex-1">
                    <Input id={`option-${i}-name`} value={o.name} placeholder="Size" onChange={(e) => setOptions((cur) => cur.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
                  </Field>
                  <Button variant="ghost" size="icon" aria-label={`Remove option ${i + 1}`} onClick={() => setOptions((cur) => cur.filter((_, j) => j !== i))}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
                <div className="flex flex-wrap gap-1">
                  {o.values.map((v) => (
                    <Badge key={v} variant="secondary" className="gap-1">
                      {v}
                      <button type="button" aria-label={`Remove ${v}`} onClick={() => setOptions((cur) => cur.map((x, j) => (j === i ? { ...x, values: x.values.filter((y) => y !== v) } : x)))}>
                        <X className="h-3 w-3" />
                      </button>
                    </Badge>
                  ))}
                </div>
                <div className="flex gap-2">
                  <Input
                    aria-label={`Option ${i + 1} values`}
                    placeholder="Add values, separated by commas"
                    value={o.pending}
                    onChange={(e) => setOptions((cur) => cur.map((x, j) => (j === i ? { ...x, pending: e.target.value } : x)))}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addValue(i);
                      }
                    }}
                  />
                  <Button variant="outline" onClick={() => addValue(i)}>Add values</Button>
                </div>
              </div>
            ))}
            {options.length < 3 ? (
              <Button variant="outline" className="justify-self-start" onClick={() => setOptions((cur) => [...cur, { name: "", values: [], pending: "" }])}>
                <Plus className="h-4 w-4" /> Add option
              </Button>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Variants ({combos.length})</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3">
            {combos.length > 1 ? (
              <div className="flex items-end gap-2">
                <Field id="bulk-price" label="Price for all variants" className="w-48">
                  <Input id="bulk-price" inputMode="decimal" value={bulkPrice} onChange={(e) => setBulkPrice(e.target.value)} />
                </Field>
                <Button variant="outline" onClick={() => combos.forEach((c) => patch(c, { price: bulkPrice }))}>Set all prices</Button>
              </div>
            ) : null}
            <div className="overflow-x-auto">
              <table className="w-full min-w-[960px] text-sm">
                <thead className="text-left text-xs text-muted-foreground">
                  <tr>
                    <th className="p-2">Variant</th>
                    <th className="p-2">Price ({currency})</th>
                    <th className="p-2">Compare-at</th>
                    <th className="p-2">Cost</th>
                    <th className="p-2">SKU</th>
                    <th className="p-2">Barcode</th>
                    <th className="p-2">Weight ({weightUnit})</th>
                    <th className="p-2">HSN</th>
                    <th className="p-2">Quantity{defaultLocation ? ` (${defaultLocation.name})` : ""}</th>
                    <th className="p-2">Image</th>
                    <th className="p-2">Flags</th>
                  </tr>
                </thead>
                <tbody>
                  {combos.map((combo) => {
                    const r = rowFor(combo);
                    const name = label(combo);
                    return (
                      <tr key={keyOf(combo)} className="border-t border-border align-top">
                        <th scope="row" className="p-2 text-left font-medium">{name}</th>
                        <td className="p-2"><Input aria-label={`Price for ${name}`} inputMode="decimal" value={r.price} onChange={(e) => patch(combo, { price: e.target.value })} className="h-8 w-24" /></td>
                        <td className="p-2"><Input aria-label={`Compare-at price for ${name}`} inputMode="decimal" value={r.compareAtPrice} onChange={(e) => patch(combo, { compareAtPrice: e.target.value })} className="h-8 w-24" /></td>
                        <td className="p-2"><Input aria-label={`Cost for ${name}`} inputMode="decimal" value={r.cost} onChange={(e) => patch(combo, { cost: e.target.value })} className="h-8 w-24" /></td>
                        <td className="p-2"><Input aria-label={`SKU for ${name}`} value={r.sku} onChange={(e) => patch(combo, { sku: e.target.value })} className="h-8 w-28" /></td>
                        <td className="p-2"><Input aria-label={`Barcode for ${name}`} value={r.barcode} onChange={(e) => patch(combo, { barcode: e.target.value })} className="h-8 w-28" /></td>
                        <td className="p-2"><Input aria-label={`Weight for ${name}`} inputMode="decimal" value={r.weight} onChange={(e) => patch(combo, { weight: e.target.value })} className="h-8 w-20" /></td>
                        <td className="p-2"><Input aria-label={`HSN code for ${name}`} inputMode="numeric" value={r.hsnCode} onChange={(e) => patch(combo, { hsnCode: e.target.value })} className="h-8 w-20" /></td>
                        <td className="p-2">
                          <Input aria-label={`Quantity for ${name}`} inputMode="numeric" disabled={!r.tracked} value={r.quantity} onChange={(e) => patch(combo, { quantity: e.target.value, quantityTouched: true })} className="h-8 w-20" />
                        </td>
                        <td className="p-2">
                          <Select aria-label={`Image for ${name}`} value={r.imageMediaId ?? ""} onChange={(e) => patch(combo, { imageMediaId: e.target.value || null })} className="h-8 w-28">
                            <option value="">None</option>
                            {media.map((m, i) => <option key={m.id} value={m.id}>Image {i + 1}</option>)}
                          </Select>
                        </td>
                        <td className="grid gap-1 p-2 text-xs">
                          <label className="flex items-center gap-1"><Checkbox checked={r.tracked} onChange={(e) => patch(combo, { tracked: e.target.checked })} aria-label={`Track quantity for ${name}`} /> Track quantity</label>
                          <label className="flex items-center gap-1"><Checkbox checked={r.inventoryPolicy === "continue"} onChange={(e) => patch(combo, { inventoryPolicy: e.target.checked ? "continue" : "deny" })} aria-label={`Continue selling ${name} when out of stock`} /> Sell when out of stock</label>
                          <label className="flex items-center gap-1"><Checkbox checked={r.requiresShipping} onChange={(e) => patch(combo, { requiresShipping: e.target.checked })} aria-label={`${name} requires shipping`} /> Requires shipping</label>
                          <label className="flex items-center gap-1"><Checkbox checked={r.taxable} onChange={(e) => patch(combo, { taxable: e.target.checked })} aria-label={`Charge tax on ${name}`} /> Taxable</label>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>Metafields</CardTitle></CardHeader>
          <CardContent className="grid gap-2">
            {meta.map((m) => (
              <div key={m.key} className="grid grid-cols-[1fr_1fr_160px_2fr_auto] items-end gap-2">
                <Input aria-label="Namespace" placeholder="namespace" value={m.namespace} onChange={(e) => setMeta((cur) => cur.map((x) => (x.key === m.key ? { ...x, namespace: e.target.value } : x)))} />
                <Input aria-label="Key" placeholder="key" value={m.field} onChange={(e) => setMeta((cur) => cur.map((x) => (x.key === m.key ? { ...x, field: e.target.value } : x)))} />
                <Select aria-label="Type" value={m.type} onChange={(e) => setMeta((cur) => cur.map((x) => (x.key === m.key ? { ...x, type: e.target.value } : x)))}>
                  {METAFIELD_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                </Select>
                <Input aria-label="Value" value={m.value} onChange={(e) => setMeta((cur) => cur.map((x) => (x.key === m.key ? { ...x, value: e.target.value } : x)))} />
                <Button variant="ghost" size="icon" aria-label="Remove metafield" onClick={() => setMeta((cur) => cur.filter((x) => x.key !== m.key))}><Trash2 className="h-4 w-4" /></Button>
              </div>
            ))}
            <Button variant="outline" className="justify-self-start" onClick={() => setMeta((cur) => [...cur, { key: crypto.randomUUID(), namespace: "custom", field: "", type: "single_line_text", value: "" }])}>
              <Plus className="h-4 w-4" /> Add metafield
            </Button>
          </CardContent>
        </Card>
      </div>

      <div className="grid content-start gap-6">
        <Card>
          <CardContent className="grid gap-4 pt-6">
            <Field id="status" label="Status">
              <Select id="status" value={status} onChange={(e) => setStatus(e.target.value as Product["status"])}>
                <option value="draft">Draft</option>
                <option value="active">Active</option>
                <option value="archived">Archived</option>
              </Select>
            </Field>
            <Button onClick={() => void save()} loading={saving} disabled={saving || uploading > 0}>Save product</Button>
            {msg ? (
              <Alert variant={msg.ok ? "success" : "error"}>
                {msg.text}
                {msg.details?.length ? <ul className="mt-1 list-disc pl-4">{msg.details.map((d) => <li key={d}>{d}</li>)}</ul> : null}
              </Alert>
            ) : null}
            {product ? (
              <p className="text-sm">
                <a className="text-primary underline" href={`/products/${product.handle}`} target="_blank" rel="noreferrer">View on storefront</a>
              </p>
            ) : null}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Organisation</CardTitle></CardHeader>
          <CardContent className="grid gap-4">
            <Field id="vendor" label="Vendor">
              <Input id="vendor" list="vendors" value={vendor} onChange={(e) => setVendor(e.target.value)} />
            </Field>
            <datalist id="vendors">{facets.vendors.map((v) => <option key={v} value={v} />)}</datalist>
            <Field id="productType" label="Product type">
              <Input id="productType" list="product-types" value={productType} onChange={(e) => setProductType(e.target.value)} />
            </Field>
            <datalist id="product-types">{facets.productTypes.map((v) => <option key={v} value={v} />)}</datalist>
            <Field id="tags" label="Tags" description="Separate with commas">
              <Input id="tags" value={tags} onChange={(e) => setTags(e.target.value)} />
            </Field>
            {product?.collections.length ? (
              <div className="text-sm">
                <p className="font-medium">Collections</p>
                <ul className="mt-1 flex flex-wrap gap-1">
                  {product.collections.map((c) => (
                    <li key={c.id}><Link href={`/collections/${c.id}`}><Badge variant="outline">{c.title}</Badge></Link></li>
                  ))}
                </ul>
              </div>
            ) : null}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Search engine listing</CardTitle></CardHeader>
          <CardContent className="grid gap-4">
            <Field id="handle" label="URL handle" description={handle ? `/products/${handle}` : "Generated from the title"}>
              <Input id="handle" value={handle} onChange={(e) => setHandle(e.target.value)} />
            </Field>
            <Field id="seoTitle" label="Page title">
              <Input id="seoTitle" value={seoTitle} maxLength={255} onChange={(e) => setSeoTitle(e.target.value)} />
            </Field>
            <Field id="seoDescription" label="Meta description">
              <Textarea id="seoDescription" value={seoDescription} maxLength={1000} onChange={(e) => setSeoDescription(e.target.value)} />
            </Field>
          </CardContent>
        </Card>
        {product ? (
          <Button variant="destructive" onClick={() => void remove()}>Delete product</Button>
        ) : null}
      </div>
    </div>
  );
}

function safeJson(v: string): unknown {
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}
