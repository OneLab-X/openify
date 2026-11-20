"use client";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { Picture } from "@/components/Picture";
import { currencyDigits, formatMoney, type StorefrontProduct } from "@/lib";
import { track } from "@/lib/track";
import { announceCart, sf, type Cart } from "@/lib/shop-client";

/** Variant picker, gallery and add to cart. */
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
  const [quantity, setQuantity] = useState(1);
  const [adding, setAdding] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const major = (minor: number) => minor / 10 ** currencyDigits(product.currency);
  useEffect(() => {
    track("view_item", { currency: product.currency, value: major(product.priceMin), items: [{ id: product.id, name: product.title, price: major(product.priceMin) }] });
    // once per product page
  }, [product.id]);

  async function addToCart() {
    if (!variant) return;
    setAdding(true);
    setMessage(null);
    try {
      const cart = await sf<Cart>("POST", "/cart/lines", { lines: [{ variantId: variant.id, quantity }] });
      announceCart(cart);
      track("add_to_cart", { currency: variant.currency, value: major(variant.price * quantity), items: [{ id: product.id, name: product.title, price: major(variant.price), quantity, variant: variant.title }] });
      setMessage({ ok: true, text: "Added to your cart" });
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : "Could not add to cart" });
    } finally {
      setAdding(false);
    }
  }

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
        <div className="flex items-end gap-3">
          <label className="grid gap-1 text-sm">
            Quantity
            <input
              type="number"
              min={1}
              max={999}
              value={quantity}
              onChange={(e) => setQuantity(Math.max(1, Math.min(999, Number(e.target.value) || 1)))}
              className="h-11 w-20 rounded-md border border-input bg-background px-3"
            />
          </label>
          <button
            type="button"
            onClick={() => void addToCart()}
            disabled={!variant?.available || adding}
            className="h-11 flex-1 rounded-md bg-primary px-6 font-medium text-primary-foreground disabled:opacity-50"
          >
            {adding ? "Adding…" : variant?.available ? "Add to cart" : "Sold out"}
          </button>
        </div>
        {message ? (
          <p role="status" className={`text-sm ${message.ok ? "text-green-700" : "text-red-700"}`}>
            {message.text}
            {message.ok ? (
              <>
                {" · "}
                <Link href="/cart" className="underline">
                  View cart
                </Link>
              </>
            ) : null}
          </p>
        ) : null}
        {/* Sanitised by the API with DOMPurify (SPEC §10). */}
        <div className="prose max-w-none text-sm" dangerouslySetInnerHTML={{ __html: product.descriptionHtml }} />
      </section>
    </div>
  );
}
