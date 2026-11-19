import type { Metadata } from "next";
import Link from "next/link";
import { ProductTable } from "@/components/catalog/ProductTable";
import { serverApi } from "@/lib/api-server";

export const metadata: Metadata = { title: "Products" };

type Search = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || undefined;
const SORTS = ["updated_desc", "created_desc", "title_asc", "title_desc", "price_asc", "price_desc", "inventory_asc", "inventory_desc"] as const;
const STATUSES = ["draft", "active", "archived"] as const;

export default async function ProductsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  const status = STATUSES.find((s) => s === one(sp.status));
  const sort = SORTS.find((s) => s === one(sp.sort));
  const availability = one(sp.availability) === "in_stock" || one(sp.availability) === "out_of_stock" ? (one(sp.availability) as "in_stock" | "out_of_stock") : undefined;
  const query = {
    ...(one(sp.q) ? { q: one(sp.q)! } : {}),
    ...(status ? { status } : {}),
    ...(one(sp.vendor) ? { vendor: one(sp.vendor)! } : {}),
    ...(one(sp.productType) ? { productType: one(sp.productType)! } : {}),
    ...(one(sp.tag) ? { tag: one(sp.tag)! } : {}),
    ...(availability ? { availability } : {}),
    ...(sort ? { sort } : {}),
    ...(one(sp.cursor) ? { cursor: one(sp.cursor)! } : {}),
    limit: 50,
  };
  const api = await serverApi();
  const [list, views, facets] = await Promise.all([
    api.GET("/api/admin/products", { params: { query } }),
    api.GET("/api/admin/product-views"),
    api.GET("/api/admin/catalog/facets"),
  ]);
  if (!list.data) return <p>You do not have access to products.</p>;
  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">Products</h1>
        <div className="flex gap-2">
          <Link href="/products/import" className="rounded-md border border-input px-4 py-2 text-sm hover:bg-muted">Import / export</Link>
          <Link href="/products/new" className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground hover:bg-primary/90">Add product</Link>
        </div>
      </div>
      <ProductTable
        items={list.data.items}
        nextCursor={list.data.nextCursor}
        filters={Object.fromEntries(Object.entries(query).filter(([k]) => k !== "limit" && k !== "cursor").map(([k, v]) => [k, String(v)]))}
        views={views.data ?? []}
        facets={facets.data ?? { vendors: [], productTypes: [], tags: [] }}
      />
    </div>
  );
}
