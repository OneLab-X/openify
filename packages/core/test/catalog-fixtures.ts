import { stores } from "@shopkit/db";
import { localStorage, type ProviderDefinition } from "@shopkit/providers";
import sharp from "sharp";
import { upsertCredential } from "../src/credentials.js";
import type { ProductInput } from "../src/catalog/products.js";
import { ACTOR, type TestDeps } from "./harness.js";

/** A second local-disk provider so media migration can be tested without cloud accounts. */
export const localB: ProviderDefinition<"storage"> = { ...localStorage, id: "local-b", displayName: "Local disk B" };

export async function makeStore(deps: TestDeps): Promise<string> {
  const [store] = await deps.db
    .insert(stores)
    .values({ name: "PLS", status: "active", currency: "INR", weightUnit: "kg", country: "IN", publicUrl: "https://shop.test" })
    .returning();
  await upsertCredential(deps, ACTOR, { storeId: store!.id, kind: "storage", provider: "local", mode: "live" }, { config: { subdirectory: "media" } });
  return store!.id;
}

export const png = (width = 1200, height = 800, color = "#c0392b") =>
  sharp({ create: { width, height, channels: 3, background: color } }).png().toBuffer();

/** 2 options × 3 values = 6 variants (the phase "Done when" product). */
export function teeInput(overrides: Partial<ProductInput> = {}): ProductInput {
  const sizes = ["S", "M", "L"];
  const colours = ["Red", "Blue"];
  return {
    title: "Block Print Tee",
    descriptionHtml: '<p>Hand <strong>block printed</strong>.</p><script>alert(1)</script><img src="x" onerror="alert(1)">',
    status: "active",
    vendor: "PLS Studio",
    productType: "T-Shirt",
    tags: ["cotton", "summer"],
    seoTitle: "Block print tee",
    options: [
      { name: "Size", values: sizes },
      { name: "Colour", values: colours },
    ],
    variants: sizes.flatMap((s, i) =>
      colours.map((c, j) => ({ options: [s, c], price: 99_900 + i * 10_000, compareAtPrice: j === 0 ? 149_900 : null, sku: `TEE-${s}-${c}`, hsnCode: "6109", weight: 0.2 })),
    ),
    ...overrides,
  };
}

/** A Shopify-format product CSV with `count` products (3 variants each, no images). */
export function shopifyCsv(count: number, opts: { offset?: number; titleSuffix?: string } = {}): string {
  const header =
    "Handle,Title,Body (HTML),Vendor,Product Category,Type,Tags,Published,Option1 Name,Option1 Value,Option1 Linked To,Option2 Name,Option2 Value,Option2 Linked To,Option3 Name,Option3 Value,Option3 Linked To,Variant SKU,Variant Grams,Variant Inventory Tracker,Variant Inventory Qty,Variant Inventory Policy,Variant Fulfillment Service,Variant Price,Variant Compare At Price,Variant Requires Shipping,Variant Taxable,Variant Barcode,Image Src,Image Position,Image Alt Text,Gift Card,SEO Title,SEO Description,Google Shopping / Google Product Category,Variant Image,Variant Weight Unit,Variant Tax Code,Cost per item,Included / India,Price / India,Status";
  const lines = [header];
  const q = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  for (let i = 0; i < count; i++) {
    const n = i + (opts.offset ?? 0);
    const handle = `csv-product-${n}`;
    ["Small", "Medium", "Large"].forEach((size, k) => {
      const first = k === 0;
      const row = [
        handle,
        first ? `CSV Product ${n}${opts.titleSuffix ?? ""}` : "",
        first ? `<p>Product <em>${n}</em>, with "quotes", commas</p>` : "",
        first ? `Vendor ${n % 7}` : "",
        "",
        first ? (n % 2 ? "Kurta" : "Saree") : "",
        first ? `imported, batch-${n % 5}` : "",
        first ? "TRUE" : "",
        first ? "Size" : "",
        size,
        "",
        "",
        "",
        "",
        "",
        "",
        "",
        `SKU-${n}-${size[0]}`,
        "250",
        "shopify",
        String(5 + k),
        "deny",
        "manual",
        (1000 + n + k * 50).toFixed(2),
        k === 0 ? (1500 + n).toFixed(2) : "",
        "TRUE",
        "TRUE",
        "",
        "",
        "",
        "",
        first ? "FALSE" : "",
        first ? `SEO ${n}` : "",
        "",
        "",
        "",
        "kg",
        "",
        "400.00",
        "TRUE",
        "",
        first ? "active" : "",
      ];
      lines.push(row.map(q).join(","));
    });
  }
  return lines.join("\n") + "\n";
}
