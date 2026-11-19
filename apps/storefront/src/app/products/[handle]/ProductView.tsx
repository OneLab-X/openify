"use client";
import { useMemo, useState } from "react";
import { Picture } from "@/components/Picture";
import { formatMoney, type StorefrontProduct } from "@/lib";

/** Variant picker + gallery. Cart and checkout arrive in Phase 3. */
export function ProductView({ product, locale, initialVariantId }: { product: StorefrontProduct; locale: string; initialVariantId: string | null }) {
  const initial = product.variants.find((v) => v.id === initialVariantId) ?? product.variants.find((v) => v.available) ?? product.variants[0];
  const [selected, setSelected] = useState<string[]>(initial?.options ?? []);
  const variant = useMemo(
    () => product.variants.find((v) => v.options.every((o, i) => o === selected[i])) ?? null,
    [product.variants, selected],
  );
  const imageOf = (imageId: string | null | undefined) => Math.max(0, product.images.findIndex((m) => m.id === imageId));
  const [active, setActive] = useState(() => imageOf(initial?.imageId));
  const shown = product.images[active] ?? product.images[0];

  function choose(index: number, value: string) {
    const next = selected.map((x, j) => (j === index ? value : x));
    setSelected(next);
    const match = product.variants.find((v) => v.options.every((o, k) => o === next[k]));
    if (match?.imageId) setActive(imageOf(match.imageId));
  }

  return (
    <div className="grid gap-8 md:grid-cols-2">
      <section aria-label="Images" className="grid gap-3">
        <div className="aspect-square overflow-hidden rounded-lg bg-muted">
          {shown ? <Picture media={shown} alt={product.title} sizes="(min-width: 768px) 50vw, 100vw" className="h-full w-full object-cover" priority /> : null}
        </div>
        {product.images.length > 1 ? (
          <ul className="grid grid-cols-5 gap-2">
            {product.images.map((m, i) => (
              <li key={m.id}>
                <button type="button" onClick={() => setActive(i)} aria-label={`Show image ${i + 1}`} aria-current={shown?.id === m.id} className="block aspect-square w-full overflow-hidden rounded border border-border aria-[current=true]:ring-2 aria-[current=true]:ring-primary">
                  <Picture media={m} alt="" sizes="20vw" className="h-full w-full object-cover" />
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </section>
      <section className="grid content-start gap-4">
        {product.vendor ? <p className="text-sm uppercase tracking-wide text-muted-foreground">{product.vendor}</p> : null}
        <h1 className="text-3xl font-semibold">{product.title}</h1>
        <p className="flex items-baseline gap-3 text-xl" aria-live="polite">
          <span data-testid="price">{formatMoney(variant?.price ?? product.priceMin, product.currency, locale)}</span>
          {variant?.compareAtPrice && variant.compareAtPrice > variant.price ? (
            <s className="text-base text-muted-foreground">{formatMoney(variant.compareAtPrice, product.currency, locale)}</s>
          ) : null}
        </p>
        {product.options.map((option, i) => (
          <fieldset key={option.name} className="grid gap-2">
            <legend className="text-sm font-medium">{option.name}</legend>
            <div className="flex flex-wrap gap-2">
              {option.values.map((value) => {
                const checked = selected[i] === value;
                return (
                  <label key={value} className={`cursor-pointer rounded-md border px-3 py-1.5 text-sm ${checked ? "border-primary bg-primary text-primary-foreground" : "border-input"}`}>
                    <input
                      type="radio"
                      className="sr-only"
                      name={`option-${i}`}
                      value={value}
                      checked={checked}
                      onChange={() => choose(i, value)}
                    />
                    {value}
                  </label>
                );
              })}
            </div>
          </fieldset>
        ))}
        <p className="text-sm" data-testid="availability">
          {!variant ? "Unavailable" : variant.available ? "In stock" : "Sold out"}
          {variant?.sku ? <span className="ml-2 text-muted-foreground">SKU {variant.sku}</span> : null}
        </p>
        <button type="button" disabled className="h-11 rounded-md bg-primary px-6 text-primary-foreground opacity-50" title="Checkout arrives soon">
          Add to cart
        </button>
        {/* Sanitised by the API with DOMPurify (SPEC §10). */}
        <div className="prose max-w-none text-sm" dangerouslySetInnerHTML={{ __html: product.descriptionHtml }} />
      </section>
    </div>
  );
}
