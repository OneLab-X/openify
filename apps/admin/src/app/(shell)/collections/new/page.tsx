import type { Metadata } from "next";
import { CollectionEditor } from "@/components/catalog/CollectionEditor";
import { requireMe } from "@/lib/session";

export const metadata: Metadata = { title: "Create collection" };

export default async function NewCollectionPage() {
  const me = await requireMe();
  return (
    <div className="grid gap-6">
      <h1 className="text-2xl font-semibold">Create collection</h1>
      <CollectionEditor collection={null} currency={me.store.currency ?? "USD"} />
    </div>
  );
}
