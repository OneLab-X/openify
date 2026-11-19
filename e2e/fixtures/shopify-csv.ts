/** A Shopify-format product CSV: `count` products × 3 size variants (no images). */
export function shopifyCsv(count: number): string {
  const header =
    "Handle,Title,Body (HTML),Vendor,Product Category,Type,Tags,Published,Option1 Name,Option1 Value,Option1 Linked To,Option2 Name,Option2 Value,Option2 Linked To,Option3 Name,Option3 Value,Option3 Linked To,Variant SKU,Variant Grams,Variant Inventory Tracker,Variant Inventory Qty,Variant Inventory Policy,Variant Fulfillment Service,Variant Price,Variant Compare At Price,Variant Requires Shipping,Variant Taxable,Variant Barcode,Image Src,Image Position,Image Alt Text,Gift Card,SEO Title,SEO Description,Google Shopping / Google Product Category,Variant Image,Variant Weight Unit,Variant Tax Code,Cost per item,Included / India,Price / India,Status";
  const q = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const lines = [header];
  for (let n = 0; n < count; n++) {
    ["Small", "Medium", "Large"].forEach((size, k) => {
      const first = k === 0;
      lines.push(
        [
          `import-${n}`, first ? `Imported Kurta ${n}` : "", first ? `<p>Cotton kurta <em>${n}</em>, "hand" made, soft</p>` : "", first ? `Weaver ${n % 7}` : "", "",
          first ? (n % 2 ? "Kurta" : "Saree") : "", first ? `imported, batch-${n % 5}` : "", first ? "TRUE" : "", first ? "Size" : "", size, "", "", "", "", "", "", "",
          `IMP-${n}-${size[0]}`, "300", "shopify", String(3 + k), "deny", "manual", (899 + n + k * 100).toFixed(2), k === 0 ? (1499 + n).toFixed(2) : "",
          "TRUE", "TRUE", "", "", "", "", first ? "FALSE" : "", first ? `Kurta ${n}` : "", "", "", "", "kg", "", "350.00", "TRUE", "", first ? "active" : "",
        ]
          .map(q)
          .join(","),
      );
    });
  }
  return lines.join("\n") + "\n";
}
