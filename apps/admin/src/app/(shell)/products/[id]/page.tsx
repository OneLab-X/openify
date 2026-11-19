import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ProductEditor } from "@/components/catalog/ProductEditor";
import { serverApi } from "@/lib/api-server";
import { requireMe } from "@/lib/session";

export const metadata: Metadata = { title: "Edit product" };

export default async function EditProductPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const me = await requireMe();
  const api = await serverApi();
  const [product, locations, facets] = await Promise.all([
    api.GET("/api/admin/products/{id}", { params: { path: { id } } }),
    api.GET("/api/admin/locations"),
    api.GET("/api/admin/catalog/facets"),
  ]);
  if (!product.data) notFound();
  return (
    <div className="grid gap-6">
      <div>
        <Link href="/products" className="text-sm text-muted-foreground hover:underline">← Products</Link>
        <h1 className="text-2xl font-semibold">{product.data.title}</h1>
      </div>
      <ProductEditor
        key={product.data.updatedAt}
        product={product.data}
        currency={product.data.currency}
        weightUnit={me.store.weightUnit ?? "kg"}
        locations={locations.data ?? []}
        facets={facets.data ?? { vendors: [], productTypes: [], tags: [] }}
      />
    </div>
  );
}
