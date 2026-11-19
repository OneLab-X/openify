import Link from "next/link";
import type { StorefrontStore } from "@/lib";
import { CartLink } from "./CartLink";

export function Header({ store }: { store: NonNullable<StorefrontStore["store"]> }) {
  return (
    <header className="border-b border-border">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-4">
        <Link href="/" className="flex items-center gap-2 font-semibold" style={{ color: store.brand.primaryColor }}>
          {store.logoUrl ? <img src={store.logoUrl} alt={`${store.name} logo`} className="h-8 w-auto" /> : null}
          <span>{store.name}</span>
        </Link>
        <div className="flex items-center gap-2">
        <form action="/search" role="search" className="flex">
          <label htmlFor="site-search" className="sr-only">Search products</label>
          <input id="site-search" name="q" type="search" placeholder="Search" className="h-9 w-40 rounded-md border border-input bg-background px-3 text-sm sm:w-64" />
        </form>
          <Link href="/account" className="inline-flex h-9 items-center rounded-md px-2 text-sm font-medium hover:bg-muted">
            Account
          </Link>
          <CartLink />
        </div>
      </div>
    </header>
  );
}
