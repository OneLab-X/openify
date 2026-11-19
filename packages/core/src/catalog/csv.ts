import { parse } from "csv-parse";
import { stringify } from "csv-stringify/sync";
import { and, asc, eq, inArray, media, productMedia, productOptions, products, productTags, productVariants, sql, tags, type Executor } from "@shopkit/db";
import type { Readable } from "node:stream";
import type { Actor, CoreDeps } from "../deps.js";
import { AppError } from "../errors.js";
import { ensureDefaultLocation, levelsForVariants } from "./inventory.js";
import { importMediaFromUrl } from "./media.js";
import { productFilterWithSearch, saveProduct, type ProductInput, type VariantInput } from "./products.js";

/**
 * Shopify product CSV (https://help.shopify.com/manual/products/import-export/using-csv). Rows are
 * grouped by Handle: the first row carries product fields, further rows add variants and/or images.
 * Unknown columns (markets, Google Shopping, metafields…) are ignored.
 */
export const SHOPIFY_COLUMNS = [
  "Handle", "Title", "Body (HTML)", "Vendor", "Product Category", "Type", "Tags", "Published",
  "Option1 Name", "Option1 Value", "Option2 Name", "Option2 Value", "Option3 Name", "Option3 Value",
  "Variant SKU", "Variant Grams", "Variant Inventory Tracker", "Variant Inventory Qty", "Variant Inventory Policy",
  "Variant Fulfillment Service", "Variant Price", "Variant Compare At Price", "Variant Requires Shipping", "Variant Taxable",
  "Variant Barcode", "Image Src", "Image Position", "Image Alt Text", "Gift Card", "SEO Title", "SEO Description",
  "Variant Image", "Variant Weight Unit", "Variant Tax Code", "Cost per item", "Status",
  // Shopkit extension (ignored by Shopify):
  "Variant HSN Code",
] as const;

type Raw = Record<string, string>;
interface CsvRow {
  line: number;
  data: Raw;
}

export interface ParsedProduct {
  handle: string;
  line: number;
  input: ProductInput;
  images: { src: string; alt: string | null; position: number }[];
  variantImages: (string | null)[];
  /** Absolute available quantity per variant (null = leave as is). */
  quantities: (number | null)[];
}

const GRAMS_PER: Record<"kg" | "g" | "lb" | "oz", number> = { kg: 1000, g: 1, lb: 453.59237, oz: 28.349523125 };
const bool = (v: string | undefined, fallback: boolean) => (v === undefined || v.trim() === "" ? fallback : /^(true|yes|1)$/i.test(v.trim()));
const text = (v: string | undefined) => (v && v.trim() ? v.trim() : null);

export function currencyDigits(currency: string): number {
  try {
    return new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    return 2;
  }
}

/** "1,299.50" → 129950 (for 2-digit currencies). Throws on anything that is not a plain amount. */
export function toMinor(value: string, digits: number): number {
  const clean = value.trim().replace(/[,\s]/g, "");
  if (!/^\d+(\.\d+)?$/.test(clean)) throw new Error(`"${value}" is not a price`);
  const [whole, frac = ""] = clean.split(".");
  const padded = (frac + "0".repeat(digits)).slice(0, digits);
  const rest = frac.slice(digits);
  let minor = Number(whole) * 10 ** digits + Number(padded || "0");
  if (rest && Number(rest[0]) >= 5) minor += 1;
  return minor;
}

export function fromMinor(minor: number, digits: number): string {
  return (minor / 10 ** digits).toFixed(digits);
}

async function readRows(input: Readable | Buffer | string): Promise<CsvRow[]> {
  const parser = parse({ columns: (header: string[]) => header.map((h) => h.trim()), bom: true, relax_column_count: true, skip_empty_lines: true, info: true });
  const rows: CsvRow[] = [];
  const done = (async () => {
    for await (const rec of parser as AsyncIterable<{ record: Raw; info: { lines: number } }>) rows.push({ line: rec.info.lines, data: rec.record });
  })();
  if (typeof input === "string" || Buffer.isBuffer(input)) parser.end(input);
  else input.pipe(parser);
  await done;
  return rows;
}

/** Parses a Shopify product CSV into product inputs. Row-level problems become per-handle errors. */
export async function parseShopifyCsv(
  input: Readable | Buffer | string,
  opts: { currency: string; weightUnit: "kg" | "g" | "lb" | "oz" },
): Promise<{ products: ParsedProduct[]; errors: { line: number; ref?: string; message: string }[] }> {
  let rows: CsvRow[];
  try {
    rows = await readRows(input);
  } catch (err) {
    throw new AppError("validation_failed", `Could not read the CSV: ${(err as Error).message}`);
  }
  if (rows.length && !("Handle" in rows[0]!.data)) throw new AppError("validation_failed", "This is not a Shopify product CSV (no Handle column)");
  const digits = currencyDigits(opts.currency);
  const groups = new Map<string, CsvRow[]>();
  const errors: { line: number; ref?: string; message: string }[] = [];
  for (const row of rows) {
    const handle = row.data.Handle?.trim().toLowerCase();
    if (!handle) {
      errors.push({ line: row.line, message: "Missing Handle" });
      continue;
    }
    groups.set(handle, [...(groups.get(handle) ?? []), row]);
  }

  const out: ParsedProduct[] = [];
  for (const [handle, group] of groups) {
    try {
      out.push(buildProduct(handle, group, digits, opts.weightUnit));
    } catch (err) {
      errors.push({ line: group[0]!.line, ref: handle, message: (err as Error).message });
    }
  }
  return { products: out, errors };
}

function buildProduct(handle: string, group: CsvRow[], digits: number, defaultUnit: "kg" | "g" | "lb" | "oz"): ParsedProduct {
  const head = group.find((r) => text(r.data.Title)) ?? group[0]!;
  const d = head.data;
  const title = text(d.Title);
  if (!title) throw new Error("Title is required on the product's first row");
  const optionNames = [1, 2, 3].map((n) => text(d[`Option${n} Name`])).filter((n): n is string => !!n);
  const noOptions = optionNames.length === 0 || (optionNames.length === 1 && optionNames[0] === "Title" && /^default title$/i.test(text(d["Option1 Value"]) ?? ""));
  const names = noOptions ? [] : optionNames;

  const variantRows = group.filter((r) => text(r.data["Option1 Value"]) || text(r.data["Variant Price"]) || text(r.data["Variant SKU"]));
  if (variantRows.length === 0) throw new Error("No variant rows (Variant Price is empty)");
  const optionValues: string[][] = names.map(() => []);
  const variants: VariantInput[] = [];
  const variantImages: (string | null)[] = [];
  const quantities: (number | null)[] = [];
  for (const r of variantRows) {
    const v = r.data;
    const values = names.map((_, i) => text(v[`Option${i + 1} Value`]) ?? "");
    values.forEach((val, i) => {
      if (!val) throw new Error(`Line ${r.line}: ${names[i]} value is empty`);
      if (!optionValues[i]!.some((x) => x.toLowerCase() === val.toLowerCase())) optionValues[i]!.push(val);
    });
    const unit = (text(v["Variant Weight Unit"])?.toLowerCase() as "kg" | "g" | "lb" | "oz" | undefined) ?? defaultUnit;
    const weightUnit = unit in GRAMS_PER ? unit : defaultUnit;
    const grams = text(v["Variant Grams"]);
    const price = text(v["Variant Price"]);
    const compare = text(v["Variant Compare At Price"]);
    const cost = text(v["Cost per item"]);
    let parsed: { price: number; compare: number | null; cost: number | null };
    try {
      parsed = {
        price: price ? toMinor(price, digits) : 0,
        compare: compare ? toMinor(compare, digits) : null,
        cost: cost ? toMinor(cost, digits) : null,
      };
    } catch (err) {
      throw new Error(`Line ${r.line}: ${(err as Error).message}`, { cause: err });
    }
    const tracker = v["Variant Inventory Tracker"];
    const qty = text(v["Variant Inventory Qty"]);
    variants.push({
      options: values,
      price: parsed.price,
      compareAtPrice: parsed.compare && parsed.compare > parsed.price ? parsed.compare : null,
      cost: parsed.cost,
      sku: text(v["Variant SKU"]),
      barcode: text(v["Variant Barcode"]),
      weight: grams ? Math.round((Number(grams) / GRAMS_PER[weightUnit]) * 1000) / 1000 : null,
      weightUnit,
      requiresShipping: bool(v["Variant Requires Shipping"], true),
      taxable: bool(v["Variant Taxable"], true),
      hsnCode: text(v["Variant HSN Code"]),
      inventoryPolicy: /continue/i.test(v["Variant Inventory Policy"] ?? "") ? "continue" : "deny",
      tracked: tracker === undefined ? true : /shopify/i.test(tracker) || (tracker.trim() !== "" && !/^none$/i.test(tracker)),
    });
    quantities.push(qty !== null && /^-?\d+$/.test(qty) ? Number(qty) : null);
    variantImages.push(text(v["Variant Image"]));
  }

  const images: ParsedProduct["images"] = [];
  for (const r of group) {
    const src = text(r.data["Image Src"]);
    if (!src || images.some((i) => i.src === src)) continue;
    const pos = Number(r.data["Image Position"]);
    images.push({ src, alt: text(r.data["Image Alt Text"]), position: Number.isFinite(pos) && pos > 0 ? pos : 1000 + images.length });
  }
  for (const src of variantImages) if (src && !images.some((i) => i.src === src)) images.push({ src, alt: null, position: 2000 + images.length });
  images.sort((a, b) => a.position - b.position);

  const statusRaw = text(d.Status)?.toLowerCase();
  const status = statusRaw === "active" || statusRaw === "draft" || statusRaw === "archived" ? statusRaw : bool(d.Published, false) ? "active" : "draft";
  return {
    handle,
    line: head.line,
    input: {
      title,
      handle,
      descriptionHtml: d["Body (HTML)"] ?? "",
      status,
      vendor: text(d.Vendor),
      productType: text(d.Type),
      tags: (d.Tags ?? "").split(",").map((t) => t.trim()).filter(Boolean),
      seoTitle: text(d["SEO Title"]),
      seoDescription: text(d["SEO Description"]),
      options: names.map((name, i) => ({ name, values: optionValues[i]! })),
      variants,
    },
    images,
    variantImages,
    quantities,
  };
}

/** Imports one parsed product (create or update by handle) in its own transaction. */
export async function importParsedProduct(
  deps: CoreDeps,
  actor: Actor,
  storeId: string,
  parsed: ParsedProduct,
  opts: { allowPrivateUrls?: boolean } = {},
): Promise<{ created: boolean; imageErrors: string[] }> {
  const imageErrors: string[] = [];
  const urlToId = new Map<string, string>();
  for (const img of parsed.images) {
    try {
      urlToId.set(img.src, await importMediaFromUrl(deps, actor, storeId, img.src, { alt: img.alt, allowPrivate: opts.allowPrivateUrls ?? false }));
    } catch (err) {
      imageErrors.push(`${img.src}: ${(err as Error).message}`);
    }
  }
  const mediaIds = parsed.images.map((i) => urlToId.get(i.src)).filter((id): id is string => !!id);
  return deps.db.transaction(async (tx) => {
    const [existing] = await tx.select({ id: products.id }).from(products).where(and(eq(products.storeId, storeId), eq(products.handle, parsed.handle)));
    const locationId = parsed.quantities.some((q) => q !== null) ? await ensureDefaultLocation(tx, storeId) : null;
    const input: ProductInput = {
      ...parsed.input,
      mediaIds,
      variants: parsed.input.variants.map((v, i) => {
        const img = parsed.variantImages[i];
        const qty = parsed.quantities[i];
        return {
          ...v,
          imageMediaId: img ? (urlToId.get(img) ?? null) : null,
          ...(locationId && qty !== null && qty !== undefined ? { inventory: [{ locationId, available: qty }] } : {}),
        };
      }),
    };
    const saved = await saveProduct(tx, actor, storeId, existing?.id ?? null, input, { inventoryReason: "import" });
    return { created: saved.created, imageErrors };
  });
}

// ── Export ───────────────────────────────────────────────────────────────────
/** Writes products matching `filter` as a Shopify-compatible CSV (header + rows). */
export async function exportShopifyCsv(
  deps: CoreDeps,
  storeId: string,
  filter: Parameters<typeof productFilterWithSearch>[2],
  onProgress?: (done: number, total: number) => Promise<void>,
): Promise<{ csv: Buffer; products: number; rows: number }> {
  const db: Executor = deps.db;
  const { rows: idRows } = await db.execute<{ id: string }>(sql`select p.id from products p where ${await productFilterWithSearch(db, storeId, filter)} order by p.created_at, p.id`);
  const ids = idRows.map((r) => r.id);
  const lines: string[][] = [[...SHOPIFY_COLUMNS]];
  const col = (name: (typeof SHOPIFY_COLUMNS)[number]) => SHOPIFY_COLUMNS.indexOf(name);
  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100);
    const [ps, opts, vs, tg, md] = await Promise.all([
      db.select().from(products).where(inArray(products.id, batch)),
      db.select().from(productOptions).where(inArray(productOptions.productId, batch)).orderBy(asc(productOptions.position)),
      db.select().from(productVariants).where(inArray(productVariants.productId, batch)).orderBy(asc(productVariants.position)),
      db.select({ productId: productTags.productId, name: tags.name }).from(productTags).innerJoin(tags, eq(tags.id, productTags.tagId)).where(inArray(productTags.productId, batch)),
      db
        .select({ productId: productMedia.productId, position: productMedia.position, media })
        .from(productMedia)
        .innerJoin(media, eq(media.id, productMedia.mediaId))
        .where(inArray(productMedia.productId, batch))
        .orderBy(asc(productMedia.position)),
    ]);
    const levels = await levelsForVariants(db, vs.map((v) => v.id));
    const byId = new Map(ps.map((p) => [p.id, p]));
    for (const id of batch) {
      const p = byId.get(id)!;
      const digits = currencyDigits(p.currency);
      const pOpts = opts.filter((o) => o.productId === id);
      const pVariants = vs.filter((v) => v.productId === id);
      const pImages = md.filter((m) => m.productId === id);
      const url = (m: (typeof pImages)[number]["media"]) => m.sourceUrl ?? `${deps.runtime.publicUrl}/media/${m.id}/${encodeURIComponent(m.filename)}`;
      const n = Math.max(pVariants.length, pImages.length);
      for (let r = 0; r < n; r++) {
        const line = new Array<string>(SHOPIFY_COLUMNS.length).fill("");
        line[col("Handle")] = p.handle;
        if (r === 0) {
          line[col("Title")] = p.title;
          line[col("Body (HTML)")] = p.descriptionHtml;
          line[col("Vendor")] = p.vendor ?? "";
          line[col("Type")] = p.productType ?? "";
          line[col("Tags")] = tg.filter((t) => t.productId === id).map((t) => t.name).join(", ");
          line[col("Published")] = p.status === "active" ? "TRUE" : "FALSE";
          line[col("Gift Card")] = "FALSE";
          line[col("SEO Title")] = p.seoTitle ?? "";
          line[col("SEO Description")] = p.seoDescription ?? "";
          line[col("Status")] = p.status;
          if (pOpts.length === 0) {
            line[col("Option1 Name")] = "Title";
          } else {
            pOpts.forEach((o, k) => (line[col(`Option${k + 1} Name` as "Option1 Name")] = o.name));
          }
        }
        const v = pVariants[r];
        if (v) {
          const inv = levels.get(v.id);
          if (pOpts.length === 0) line[col("Option1 Value")] = "Default Title";
          else [v.option1, v.option2, v.option3].slice(0, pOpts.length).forEach((val, k) => (line[col(`Option${k + 1} Value` as "Option1 Value")] = val ?? ""));
          line[col("Variant SKU")] = v.sku ?? "";
          line[col("Variant Grams")] = v.weight !== null ? String(Math.round(v.weight * GRAMS_PER[v.weightUnit])) : "0";
          line[col("Variant Inventory Tracker")] = inv?.tracked === false ? "" : "shopify";
          line[col("Variant Inventory Qty")] = String(inv?.levels.reduce((s, l) => s + l.available, 0) ?? 0);
          line[col("Variant Inventory Policy")] = v.inventoryPolicy;
          line[col("Variant Fulfillment Service")] = "manual";
          line[col("Variant Price")] = fromMinor(v.price, digits);
          line[col("Variant Compare At Price")] = v.compareAtPrice !== null ? fromMinor(v.compareAtPrice, digits) : "";
          line[col("Variant Requires Shipping")] = v.requiresShipping ? "TRUE" : "FALSE";
          line[col("Variant Taxable")] = v.taxable ? "TRUE" : "FALSE";
          line[col("Variant Barcode")] = v.barcode ?? "";
          line[col("Variant Weight Unit")] = v.weightUnit;
          line[col("Cost per item")] = v.cost !== null ? fromMinor(v.cost, digits) : "";
          line[col("Variant HSN Code")] = v.hsnCode ?? "";
          const vImg = v.imageMediaId ? pImages.find((m) => m.media.id === v.imageMediaId) : undefined;
          line[col("Variant Image")] = vImg ? url(vImg.media) : "";
        }
        const img = pImages[r];
        if (img) {
          line[col("Image Src")] = url(img.media);
          line[col("Image Position")] = String(r + 1);
          line[col("Image Alt Text")] = img.media.alt ?? "";
        }
        lines.push(line);
      }
    }
    await onProgress?.(Math.min(i + 100, ids.length), ids.length);
  }
  return { csv: Buffer.from(stringify(lines)), products: ids.length, rows: lines.length - 1 };
}
