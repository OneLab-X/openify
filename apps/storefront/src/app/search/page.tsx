import type { Metadata } from "next";
import { ThemeShell } from "@/components/ThemeShell";
import Link from "next/link";
import { connection } from "next/server";
import { ProductGrid } from "@/components/ProductGrid";
import { getStore, one, search } from "@/lib";

export const metadata: Metadata = { title: "Search", robots: { index: false } };

export default async function SearchPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await connection();
  const sp = await searchParams;
  const q = one(sp.q)?.trim().slice(0, 200) ?? "";
  const cursor = one(sp.cursor);
  const [{ store }, results] = await Promise.all([getStore(), q ? search(q, cursor) : Promise.resolve(null)]);
  return (
    <ThemeShell template="search">
    <div className="sk-container grid gap-6 py-8">
      <h1 className="text-2xl font-semibold">{q ? `Results for “${q}”` : "Search"}</h1>
      <form action="/search" role="search" className="flex gap-2">
        <label htmlFor="q" className="sr-only">Search products</label>
        <input id="q" name="q" type="search" defaultValue={q} className="h-10 flex-1 rounded-md border border-input px-3" />
        <button type="submit" className="h-10 rounded-md bg-primary px-4 text-primary-foreground">Search</button>
      </form>
      {results ? (
        <>
          <p className="text-sm text-muted-foreground">{results.total} product{results.total === 1 ? "" : "s"}</p>
          <ProductGrid products={results.items} {...(store?.locale ? { locale: store.locale } : {})} />
          {results.nextCursor ? (
            <Link href={`/search?q=${encodeURIComponent(q)}&cursor=${encodeURIComponent(results.nextCursor)}`} className="justify-self-center rounded-md border border-input px-4 py-2 text-sm">
              Next page
            </Link>
          ) : null}
        </>
      ) : null}
    </div>
    </ThemeShell>
  );
}
