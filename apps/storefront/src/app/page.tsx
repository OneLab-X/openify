import Link from "next/link";
import { connection } from "next/server";
import { Picture } from "@/components/Picture";
import { ProductGrid } from "@/components/ProductGrid";
import { getStore, listCollections, listProducts } from "@/lib";

/** Basic home (Phase 5 replaces it with the theme system): collections and newest products. */
export default async function Home() {
  await connection();
  const { setupRequired, store } = await getStore();

  if (setupRequired || !store) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-3 px-4 text-center">
        <h1 className="text-3xl font-semibold">Coming soon</h1>
        <p className="text-muted-foreground">This shop is being set up. Please check back shortly.</p>
      </main>
    );
  }

  const [collections, latest] = await Promise.all([listCollections(), listProducts({ sort: "created_desc", limit: 12 })]);
  return (
    <main className="mx-auto grid max-w-6xl gap-10 px-4 py-8">
      <section className="py-6 text-center">
        <h1 className="text-4xl font-semibold" style={{ color: store.brand.primaryColor }}>{store.name}</h1>
      </section>
      {collections.length ? (
        <section aria-labelledby="collections-heading" className="grid gap-4">
          <h2 id="collections-heading" className="text-xl font-semibold">Collections</h2>
          <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3">
            {collections.map((c) => (
              <li key={c.id}>
                <Link href={`/collections/${c.handle}`} className="block rounded-lg border border-border p-3 hover:bg-muted">
                  {c.image ? <Picture media={c.image} alt={c.title} sizes="33vw" className="mb-2 aspect-video w-full rounded object-cover" /> : null}
                  <span className="font-medium">{c.title}</span>
                  <span className="ml-2 text-sm text-muted-foreground">{c.productsCount}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <section aria-labelledby="latest-heading" className="grid gap-4">
        <h2 id="latest-heading" className="text-xl font-semibold">New arrivals</h2>
        <ProductGrid products={latest.items} {...(store.locale ? { locale: store.locale } : {})} />
      </section>
    </main>
  );
}
