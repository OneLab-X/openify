import type { Metadata } from "next";
import Link from "next/link";
import { JobsPanel } from "@/components/catalog/JobsPanel";
import { serverApi } from "@/lib/api-server";

export const metadata: Metadata = { title: "Import and export products" };

export default async function ImportPage() {
  const api = await serverApi();
  const [imports, exports] = await Promise.all([
    api.GET("/api/admin/jobs", { params: { query: { type: "product_import" } } }),
    api.GET("/api/admin/jobs", { params: { query: { type: "product_export" } } }),
  ]);
  return (
    <div className="grid gap-6">
      <div>
        <Link href="/products" className="text-sm text-muted-foreground hover:underline">← Products</Link>
        <h1 className="text-2xl font-semibold">Import and export</h1>
        <p className="text-sm text-muted-foreground">
          Uses Shopify&apos;s product CSV format. Re-importing updates products with the same handle instead of duplicating them.
        </p>
      </div>
      <JobsPanel initial={[...(imports.data ?? []), ...(exports.data ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt))} />
    </div>
  );
}
