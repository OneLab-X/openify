import type { Metadata } from "next";
import { ProductEditor } from "@/components/catalog/ProductEditor";
import { serverApi } from "@/lib/api-server";
import { requireMe } from "@/lib/session";

export const metadata: Metadata = { title: "Add product" };

export default async function NewProductPage() {
  const me = await requireMe();
  const api = await serverApi();
  const [locations, facets] = await Promise.all([api.GET("/api/admin/locations"), api.GET("/api/admin/catalog/facets")]);
  return (
    <div className="grid gap-6">
      <h1 className="text-2xl font-semibold">Add product</h1>
      <ProductEditor
        product={null}
        currency={me.store.currency ?? "USD"}
        weightUnit={me.store.weightUnit ?? "kg"}
        locations={locations.data ?? []}
        facets={facets.data ?? { vendors: [], productTypes: [], tags: [] }}
      />
    </div>
  );
}
