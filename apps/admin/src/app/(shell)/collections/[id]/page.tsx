import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CollectionEditor } from "@/components/catalog/CollectionEditor";
import { serverApi } from "@/lib/api-server";
import { requireMe } from "@/lib/session";

export const metadata: Metadata = { title: "Edit collection" };

export default async function EditCollectionPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ saved?: string }> }) {
  const [{ id }, { saved }] = await Promise.all([params, searchParams]);
  const me = await requireMe();
  const api = await serverApi();
  const { data } = await api.GET("/api/admin/collections/{id}", { params: { path: { id } } });
  if (!data) notFound();
  return (
    <div className="grid gap-6">
      <div>
        <Link href="/collections" className="text-sm text-muted-foreground hover:underline">← Collections</Link>
        <h1 className="text-2xl font-semibold">{data.title}</h1>
      </div>
      <CollectionEditor
        key={data.updatedAt}
        collection={data}
        currency={me.store.currency ?? "USD"}
        {...(saved ? { flash: `Collection saved (${data.productsCount} products).` } : {})}
      />
    </div>
  );
}
