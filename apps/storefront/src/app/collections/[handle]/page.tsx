import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { ProductGrid } from "@/components/ProductGrid";
import { currencyDigits, getCollection, getFacets, getStore, listCollectionProducts, many, one, type ListQuery } from "@/lib";

type Search = Record<string, string | string[] | undefined>;
type Props = { params: Promise<{ handle: string }>; searchParams: Promise<Search> };

const SORTS = [
  ["manual", "Featured"],
  ["best_selling", "Best selling"],
  ["title_asc", "A–Z"],
  ["title_desc", "Z–A"],
  ["price_asc", "Price, low to high"],
  ["price_desc", "Price, high to low"],
  ["created_desc", "Newest"],
  ["created_asc", "Oldest"],
] as const;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const c = await getCollection((await params).handle);
  if (!c) return {};
  return { title: c.seo.title, ...(c.seo.description ? { description: c.seo.description } : {}), alternates: { canonical: `/collections/${c.handle}` } };
}

/** Collection page with GET-form filters (works without JavaScript) and cursor "load more". */
export default async function CollectionPage({ params, searchParams }: Props) {
  await connection();
  const [{ handle }, sp] = await Promise.all([params, searchParams]);
  const [collection, { store }] = await Promise.all([getCollection(handle), getStore()]);
  if (!collection || !store) notFound();
  const digits = currencyDigits(store.currency ?? "USD");
  const toMinor = (v: string | undefined) => (v && /^\d+(\.\d+)?$/.test(v) ? Math.round(Number(v) * 10 ** digits) : undefined);
  const sort = SORTS.find(([k]) => k === one(sp.sort))?.[0];
  const priceMin = toMinor(one(sp.min));
  const priceMax = toMinor(one(sp.max));
  const cursor = one(sp.cursor);
  const query: ListQuery = {
    limit: 24,
    ...(sort ? { sort } : {}),
    ...(cursor ? { cursor } : {}),
    ...(priceMin !== undefined ? { priceMin } : {}),
    ...(priceMax !== undefined ? { priceMax } : {}),
    ...(one(sp.available) === "true" ? { available: "true" as const } : {}),
    ...(many(sp.tag).length ? { tag: many(sp.tag) } : {}),
    ...(many(sp.option).length ? { option: many(sp.option) } : {}),
  };
  const [page, facets] = await Promise.all([listCollectionProducts(handle, query), getFacets(handle)]);
  const nextParams = new URLSearchParams();
  for (const [k, v] of Object.entries(sp)) if (k !== "cursor") for (const x of many(v)) nextParams.append(k, x);
  if (page.nextCursor) nextParams.set("cursor", page.nextCursor);

  return (
    <main className="mx-auto grid max-w-6xl gap-6 px-4 py-8">
      <header className="grid gap-2">
        <h1 className="text-3xl font-semibold">{collection.title}</h1>
        {/* Sanitised by the API with DOMPurify. */}
        {collection.descriptionHtml ? <div className="text-muted-foreground" dangerouslySetInnerHTML={{ __html: collection.descriptionHtml }} /> : null}
      </header>
      <div className="grid gap-6 md:grid-cols-[220px_1fr]">
        <form method="get" className="grid content-start gap-4 text-sm" aria-label="Filters">
          <label className="grid gap-1">
            <span className="font-medium">Sort by</span>
            <select name="sort" defaultValue={sort ?? collection.sortOrder} className="h-9 rounded-md border border-input bg-background px-2">
              {SORTS.filter(([k]) => k !== "manual" || collection.sortOrder === "manual").map(([k, label]) => (
                <option key={k} value={k}>{label}</option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" name="available" value="true" defaultChecked={one(sp.available) === "true"} /> In stock only
          </label>
          <fieldset className="grid gap-1">
            <legend className="font-medium">Price</legend>
            <div className="flex gap-2">
              <input name="min" inputMode="decimal" placeholder="Min" defaultValue={one(sp.min)} aria-label="Minimum price" className="h-9 w-full rounded-md border border-input px-2" />
              <input name="max" inputMode="decimal" placeholder="Max" defaultValue={one(sp.max)} aria-label="Maximum price" className="h-9 w-full rounded-md border border-input px-2" />
            </div>
          </fieldset>
          {facets?.options.map((o) => (
            <fieldset key={o.name} className="grid gap-1">
              <legend className="font-medium">{o.name}</legend>
              {o.values.map((v) => (
                <label key={v.value} className="flex items-center gap-2">
                  <input type="checkbox" name="option" value={`${o.name}:${v.value}`} defaultChecked={many(sp.option).includes(`${o.name}:${v.value}`)} />
                  {v.value} <span className="text-muted-foreground">({v.count})</span>
                </label>
              ))}
            </fieldset>
          ))}
          {facets?.tags.length ? (
            <fieldset className="grid gap-1">
              <legend className="font-medium">Tags</legend>
              {facets.tags.slice(0, 20).map((t) => (
                <label key={t.value} className="flex items-center gap-2">
                  <input type="checkbox" name="tag" value={t.value} defaultChecked={many(sp.tag).includes(t.value)} /> {t.value}
                </label>
              ))}
            </fieldset>
          ) : null}
          <button type="submit" className="h-9 rounded-md bg-primary px-3 text-primary-foreground">Apply</button>
        </form>
        <div className="grid content-start gap-6">
          <ProductGrid products={page.items} {...(store.locale ? { locale: store.locale } : {})} />
          {page.nextCursor ? (
            <Link href={`/collections/${collection.handle}?${nextParams.toString()}`} className="justify-self-center rounded-md border border-input px-4 py-2 text-sm hover:bg-muted">
              Next page
            </Link>
          ) : null}
        </div>
      </div>
    </main>
  );
}
