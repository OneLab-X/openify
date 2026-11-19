import type { Metadata } from "next";
import { InventoryTable } from "@/components/catalog/InventoryTable";
import { serverApi } from "@/lib/api-server";

export const metadata: Metadata = { title: "Inventory" };

type Search = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || undefined;

export default async function InventoryPage({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  const api = await serverApi();
  const { data: locations } = await api.GET("/api/admin/locations");
  if (!locations) return <p>You do not have access to inventory.</p>;
  const location = locations.find((l) => l.id === one(sp.location)) ?? locations.find((l) => l.isDefault) ?? locations[0];
  const page = location
    ? await api.GET("/api/admin/inventory", {
        params: { query: { locationId: location.id, limit: 100, ...(one(sp.q) ? { q: one(sp.q)! } : {}), ...(one(sp.cursor) ? { cursor: one(sp.cursor)! } : {}) } },
      })
    : null;
  return (
    <div className="grid gap-6">
      <h1 className="text-2xl font-semibold">Inventory</h1>
      <InventoryTable locations={locations} location={location ?? null} items={page?.data?.items ?? []} nextCursor={page?.data?.nextCursor ?? null} q={one(sp.q) ?? ""} />
    </div>
  );
}
