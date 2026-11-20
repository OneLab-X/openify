import type { ReactNode } from "react";
import type { ThemeImage, ThemeProductCard } from "./types.js";

export const str = (v: unknown): string => (typeof v === "string" ? v : "");
export const num = (v: unknown, d = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : d);
export const bool = (v: unknown): boolean => v === true;
export const img = (v: unknown): ThemeImage | null => (v && typeof v === "object" && typeof (v as ThemeImage).url === "string" ? (v as ThemeImage) : null);

export function formatMoney(minor: number, currency: string, locale = "en"): string {
  let digits = 2;
  try {
    digits = new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    /* default */
  }
  return new Intl.NumberFormat(locale, { style: "currency", currency, minimumFractionDigits: digits }).format(minor / 10 ** digits);
}

const PAD: Record<string, string> = { none: "py-0", small: "py-6", medium: "py-10 md:py-14", large: "py-14 md:py-20" };
export const pad = (v: unknown) => PAD[str(v)] ?? PAD.medium!;
export const scheme = (v: unknown) => `sk-scheme-${["background", "muted", "accent", "inverse"].includes(str(v)) ? str(v) : "background"}`;

/** Responsive picture from renditions; lazy unless it is the page's first (LCP) image. */
export function Img({ image, alt, sizes, className, priority = false }: { image: ThemeImage; alt: string; sizes: string; className?: string; priority?: boolean }) {
  const set = (f: "avif" | "webp") =>
    (image.sources ?? [])
      .filter((s) => s.format === f)
      .map((s) => `${s.url} ${s.width}w`)
      .join(", ");
  const avif = set("avif");
  const webp = set("webp");
  return (
    <picture>
      {avif ? <source type="image/avif" srcSet={avif} sizes={sizes} /> : null}
      {webp ? <source type="image/webp" srcSet={webp} sizes={sizes} /> : null}
      <img
        src={image.url}
        alt={image.alt ?? alt}
        width={image.width ?? undefined}
        height={image.height ?? undefined}
        loading={priority ? "eager" : "lazy"}
        fetchPriority={priority ? "high" : undefined}
        decoding={priority ? "sync" : "async"}
        className={className}
      />
    </picture>
  );
}

export function Price({ p, locale }: { p: Pick<ThemeProductCard, "priceMin" | "priceMax" | "compareAtPriceMax" | "currency">; locale: string }) {
  const sale = p.compareAtPriceMax !== null && p.compareAtPriceMax > p.priceMax;
  return (
    <span className="flex flex-wrap items-baseline gap-2">
      <span className={sale ? "sk-sale" : undefined}>
        {sale ? <span className="sr-only">Sale price </span> : null}
        {p.priceMin === p.priceMax ? formatMoney(p.priceMin, p.currency, locale) : `From ${formatMoney(p.priceMin, p.currency, locale)}`}
      </span>
      {sale ? (
        <s className="text-sm opacity-70">
          <span className="sr-only">Regular price </span>
          {formatMoney(p.compareAtPriceMax!, p.currency, locale)}
        </s>
      ) : null}
    </span>
  );
}

export function ButtonLink({ href, label, variant = "solid" }: { href: string; label: string; variant?: "solid" | "outline" }) {
  return (
    <a href={href} className={`sk-button ${variant === "outline" ? "sk-button-outline" : ""}`}>
      {label}
    </a>
  );
}

/** The width container all sections share. */
export const Container = ({ children, className = "" }: { children: ReactNode; className?: string }) => <div className={`sk-container ${className}`}>{children}</div>;
