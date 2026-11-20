import type { Metadata } from "next";
import { currencyDigits, type StorefrontProduct, type StorefrontStore } from "./index";

/**
 * Metadata and JSON-LD builders (SPEC §11, ported from PLS `src/lib/seo.ts` and `JsonLd.tsx`):
 * every indexable page gets a title, description, canonical URL and matching Open Graph/Twitter
 * tags; structured data follows schema.org for Google's rich results.
 */
type Store = NonNullable<StorefrontStore["store"]>;

const TITLE_MAX = 70;
const DESCRIPTION_MAX = 155;

/** Shortens text to `max` characters at a word boundary, adding "…" when cut. */
export function clampText(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,.;:–—-]+$/, "")}…`;
}

export const siteUrl = (store: Store | null | undefined) => (store?.publicUrl ?? process.env.PUBLIC_URL ?? "http://localhost:3000").replace(/\/$/, "");
export const absoluteUrl = (store: Store | null | undefined, path: string) => new URL(path, `${siteUrl(store)}/`).toString();

export interface PageSeo {
  title: string;
  description?: string | null;
  path: string;
  image?: { url: string; alt?: string | null; width?: number | null; height?: number | null } | null;
  type?: "website" | "article";
  noindex?: boolean;
}

/** Child pages must set every field: Next replaces (not merges) a parent's openGraph. */
export function pageMetadata(store: Store | null | undefined, { title, description, path, image, type = "website", noindex }: PageSeo): Metadata {
  const name = store?.name ?? "";
  const shortTitle = clampText(title, TITLE_MAX - name.length - 3);
  const desc = description ? clampText(description, DESCRIPTION_MAX) : undefined;
  const images = image ? [{ url: absoluteUrl(store, image.url), ...(image.width ? { width: image.width } : {}), ...(image.height ? { height: image.height } : {}), alt: image.alt ?? title }] : undefined;
  return {
    title: shortTitle,
    ...(desc ? { description: desc } : {}),
    alternates: { canonical: path },
    openGraph: { type, siteName: name, url: path, title: `${shortTitle} · ${name}`, ...(desc ? { description: desc } : {}), ...(images ? { images } : {}), ...(store?.locale ? { locale: store.locale.replace("-", "_") } : {}) },
    twitter: { card: images ? "summary_large_image" : "summary", title: `${shortTitle} · ${name}`, ...(desc ? { description: desc } : {}), ...(images ? { images: images.map((i) => i.url) } : {}) },
    ...(noindex ? { robots: { index: false, follow: true } } : {}),
  };
}

const major = (minor: number, currency: string) => (minor / 10 ** currencyDigits(currency)).toFixed(currencyDigits(currency));
type Ld = Record<string, unknown>;

export function organizationLd(store: Store): Ld {
  const url = siteUrl(store);
  const a = store.address;
  return {
    "@type": "Organization",
    "@id": `${url}/#organization`,
    name: store.name,
    url: `${url}/`,
    ...(store.logoUrl ? { logo: absoluteUrl(store, store.logoUrl) } : {}),
    ...(store.email ? { email: store.email } : {}),
    ...(store.phone ? { telephone: store.phone } : {}),
    ...(a.city || a.country
      ? { address: { "@type": "PostalAddress", ...(a.line1 ? { streetAddress: [a.line1, a.line2].filter(Boolean).join(", ") } : {}), ...(a.city ? { addressLocality: a.city } : {}), ...(a.province ? { addressRegion: a.province } : {}), ...(a.postalCode ? { postalCode: a.postalCode } : {}), ...(a.country ? { addressCountry: a.country } : {}) } }
      : {}),
  };
}

/** WebSite with a SearchAction (sitelinks search box). */
export function websiteLd(store: Store): Ld {
  const url = siteUrl(store);
  return {
    "@type": "WebSite",
    "@id": `${url}/#website`,
    url: `${url}/`,
    name: store.name,
    publisher: { "@id": `${url}/#organization` },
    potentialAction: { "@type": "SearchAction", target: { "@type": "EntryPoint", urlTemplate: `${url}/search?q={search_term_string}` }, "query-input": "required name=search_term_string" },
  };
}

export interface Rating {
  value: number;
  count: number;
}

/**
 * Product with one Offer per variant (or an AggregateOffer for a price range). `rating` is the
 * hook for reviews (AggregateRating) once a review provider exists; without reviews it is omitted,
 * as Google requires real ratings.
 */
export function productLd(store: Store, p: StorefrontProduct, rating?: Rating | null): Ld {
  const url = absoluteUrl(store, `/products/${p.handle}`);
  const description = p.seo.description ?? "";
  const offers = p.variants.map((v) => ({
    "@type": "Offer",
    url: p.variants.length > 1 ? `${url}?variant=${v.id}` : url,
    ...(v.sku ? { sku: v.sku } : {}),
    price: major(v.price, v.currency),
    priceCurrency: v.currency,
    availability: v.available ? "https://schema.org/InStock" : "https://schema.org/OutOfStock",
    itemCondition: "https://schema.org/NewCondition",
    seller: { "@id": `${siteUrl(store)}/#organization` },
  }));
  return {
    "@type": "Product",
    "@id": `${url}#product`,
    name: p.title,
    url,
    ...(description ? { description } : {}),
    ...(p.images.length ? { image: p.images.slice(0, 6).map((i) => absoluteUrl(store, i.url)) } : {}),
    ...(p.variants[0]?.sku ? { sku: p.variants[0].sku } : {}),
    brand: { "@type": "Brand", name: p.vendor || store.name },
    ...(p.productType ? { category: p.productType } : {}),
    offers: offers.length === 1 ? offers[0] : { "@type": "AggregateOffer", lowPrice: major(p.priceMin, p.currency), highPrice: major(p.priceMax, p.currency), priceCurrency: p.currency, offerCount: offers.length, offers },
    ...(rating && rating.count > 0 ? { aggregateRating: { "@type": "AggregateRating", ratingValue: rating.value, reviewCount: rating.count, bestRating: 5, worstRating: 1 } } : {}),
  };
}

export function breadcrumbLd(store: Store, items: { name: string; path: string }[]): Ld {
  return {
    "@type": "BreadcrumbList",
    itemListElement: items.map((it, i) => ({ "@type": "ListItem", position: i + 1, name: it.name, item: absoluteUrl(store, it.path) })),
  };
}

export function collectionLd(store: Store, c: { title: string; handle: string; description?: string | null }, products: { handle: string; title: string }[]): Ld {
  const url = absoluteUrl(store, `/collections/${c.handle}`);
  return {
    "@type": "CollectionPage",
    "@id": url,
    url,
    name: c.title,
    ...(c.description ? { description: c.description } : {}),
    isPartOf: { "@id": `${siteUrl(store)}/#website` },
    mainEntity: { "@type": "ItemList", itemListElement: products.map((p, i) => ({ "@type": "ListItem", position: i + 1, url: absoluteUrl(store, `/products/${p.handle}`), name: p.title })) },
  };
}

export function articleLd(store: Store, a: { title: string; url: string; description: string; author: string | null; publishedAt: string | null; updatedAt: string; image: { url: string } | null }): Ld {
  return {
    "@type": "BlogPosting",
    headline: a.title.slice(0, 110),
    url: absoluteUrl(store, a.url),
    mainEntityOfPage: absoluteUrl(store, a.url),
    description: a.description,
    ...(a.image ? { image: [absoluteUrl(store, a.image.url)] } : {}),
    ...(a.publishedAt ? { datePublished: a.publishedAt } : {}),
    dateModified: a.updatedAt,
    author: a.author ? { "@type": "Person", name: a.author } : { "@type": "Organization", name: store.name, url: `${siteUrl(store)}/` },
    publisher: { "@id": `${siteUrl(store)}/#organization` },
  };
}

/** One JSON-LD graph per page. */
export const graph = (...nodes: Ld[]) => ({ "@context": "https://schema.org", "@graph": nodes });
