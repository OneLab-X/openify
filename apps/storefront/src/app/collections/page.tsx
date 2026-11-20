import type { Metadata } from "next";
import { connection } from "next/server";
import { Picture } from "@/components/Picture";
import { ThemeShell } from "@/components/ThemeShell";
import { getStore, listCollections } from "@/lib";
import { pageMetadata } from "@/lib/seo";

export async function generateMetadata(): Promise<Metadata> {
  const { store } = await getStore();
  return pageMetadata(store, { title: "Collections", description: store ? `All collections at ${store.name}` : null, path: "/collections" });
}

export default async function CollectionsPage() {
  await connection();
  const collections = await listCollections();
  return (
    <ThemeShell template="collection">
      <div className="sk-container grid gap-6 py-10">
        <h1 className="text-3xl font-semibold">Collections</h1>
        <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          {collections.map((c) => (
            <li key={c.id}>
              <a href={`/collections/${c.handle}`} className="group grid gap-2">
                <div className="sk-card-image">{c.image ? <Picture media={c.image} alt="" sizes="33vw" className="h-full w-full object-cover" /> : null}</div>
                <span className="font-medium group-hover:underline">{c.title}</span>
                <span className="text-sm opacity-75">{c.productsCount} products</span>
              </a>
            </li>
          ))}
        </ul>
      </div>
    </ThemeShell>
  );
}
