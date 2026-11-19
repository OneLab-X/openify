import Link from "next/link";
import { formatMoney, type ProductCard } from "@/lib";
import { Picture } from "./Picture";

export function Price({ min, max, compareAt, currency, locale }: { min: number; max: number; compareAt?: number | null; currency: string; locale?: string }) {
  return (
    <span className="flex items-baseline gap-2">
      <span>{min === max ? formatMoney(min, currency, locale) : `From ${formatMoney(min, currency, locale)}`}</span>
      {compareAt && compareAt > max ? <s className="text-sm text-muted-foreground">{formatMoney(compareAt, currency, locale)}</s> : null}
    </span>
  );
}

export function ProductGrid({ products, locale }: { products: ProductCard[]; locale?: string }) {
  if (products.length === 0) return <p className="text-muted-foreground">No products found.</p>;
  return (
    <ul className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4" aria-label="Products">
      {products.map((p) => (
        <li key={p.id}>
          <Link href={`/products/${p.handle}`} className="group block">
            <div className="aspect-square overflow-hidden rounded-lg bg-muted">
              {p.image ? (
                <Picture media={p.image} alt={p.title} sizes="(min-width: 1024px) 25vw, (min-width: 640px) 33vw, 50vw" className="h-full w-full object-cover transition-transform group-hover:scale-105" />
              ) : null}
            </div>
            <h3 className="mt-2 text-sm font-medium">{p.title}</h3>
            <div className="text-sm">
              <Price min={p.priceMin} max={p.priceMax} compareAt={p.compareAtPriceMax} currency={p.currency} {...(locale ? { locale } : {})} />
            </div>
            {!p.available ? <p className="text-xs text-muted-foreground">Sold out</p> : null}
          </Link>
        </li>
      ))}
    </ul>
  );
}
