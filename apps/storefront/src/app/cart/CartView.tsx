"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Picture } from "@/components/Picture";
import { formatMoney } from "@/lib";
import { announceCart, sf, type Cart } from "@/lib/shop-client";

export function CartView({ locale }: { locale: string }) {
  const router = useRouter();
  const [cart, setCart] = useState<Cart | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState("");
  const [note, setNote] = useState("");

  useEffect(() => {
    sf<Cart>("GET", "/cart")
      .then((c) => {
        setCart(c);
        setNote(c.note ?? "");
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Could not load your cart"));
  }, []);

  async function run(fn: () => Promise<Cart>) {
    setBusy(true);
    setError(null);
    try {
      const next = await fn();
      setCart(next);
      announceCart(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  async function checkout() {
    setBusy(true);
    setError(null);
    try {
      if ((cart?.note ?? "") !== note) await sf<Cart>("PATCH", "/cart", { note });
      const { checkoutId } = await sf<{ checkoutId: string }>("POST", "/checkout");
      router.push(`/checkout?id=${checkoutId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start checkout");
      setBusy(false);
    }
  }

  if (!cart) return <p className="text-muted-foreground">{error ?? "Loading…"}</p>;
  const money = (n: number) => formatMoney(n, cart.currency, locale);
  if (cart.lines.length === 0) {
    return (
      <div className="grid gap-4">
        <p>Your cart is empty.</p>
        <Link href="/" className="underline">
          Continue shopping
        </Link>
      </div>
    );
  }

  return (
    <div className="grid gap-8 md:grid-cols-[1fr_18rem]">
      <ul className="divide-y divide-border border-y border-border" aria-label="Cart items">
        {cart.lines.map((l) => (
          <li key={l.id} className="flex gap-4 py-4" data-testid="cart-line">
            <div className="h-20 w-20 shrink-0 overflow-hidden rounded bg-muted">
              {l.image ? <Picture media={l.image} alt="" sizes="80px" className="h-full w-full object-cover" /> : null}
            </div>
            <div className="grid flex-1 gap-1">
              <Link href={`/products/${l.productHandle}`} className="font-medium hover:underline">
                {l.title}
              </Link>
              {l.variantTitle ? <p className="text-sm text-muted-foreground">{l.variantTitle}</p> : null}
              {Object.entries(l.attributes).map(([k, v]) => (
                <p key={k} className="text-xs text-muted-foreground">
                  {k}: {v}
                </p>
              ))}
              {l.stockIssue ? <p className="text-sm text-red-700">{l.stockIssue}</p> : null}
              <div className="mt-1 flex items-center gap-3">
                <label className="text-sm">
                  <span className="sr-only">Quantity for {l.title}</span>
                  <input
                    type="number"
                    min={0}
                    max={999}
                    defaultValue={l.quantity}
                    disabled={busy}
                    onBlur={(e) => {
                      const q = Math.max(0, Math.min(999, Number(e.target.value) || 0));
                      if (q !== l.quantity) void run(() => sf<Cart>("PATCH", `/cart/lines/${l.id}`, { quantity: q }));
                    }}
                    className="h-9 w-20 rounded-md border border-input bg-background px-2"
                  />
                </label>
                <button type="button" disabled={busy} onClick={() => void run(() => sf<Cart>("DELETE", `/cart/lines/${l.id}`))} className="text-sm underline">
                  Remove
                </button>
              </div>
            </div>
            <p className="text-right font-medium">{money(l.subtotal)}</p>
          </li>
        ))}
      </ul>
      <aside className="grid content-start gap-4">
        {cart.unavailable.length ? <p className="text-sm text-red-700">Some items are no longer available and were left out.</p> : null}
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => sf<Cart>("PATCH", "/cart", { discountCode: code }));
          }}
        >
          <label className="sr-only" htmlFor="discount">
            Discount code
          </label>
          <input id="discount" value={code} onChange={(e) => setCode(e.target.value)} placeholder="Discount code" className="h-9 min-w-0 flex-1 rounded-md border border-input bg-background px-3 text-sm" />
          <button type="submit" disabled={busy || !code.trim()} className="h-9 rounded-md border border-input px-3 text-sm">
            Apply
          </button>
        </form>
        {cart.discount.code ? (
          <p className={`text-sm ${cart.discount.applied ? "text-green-700" : "text-red-700"}`}>
            {cart.discount.applied ? `${cart.discount.code.toUpperCase()} applied` : cart.discount.error}{" "}
            <button type="button" className="underline" onClick={() => void run(() => sf<Cart>("PATCH", "/cart", { discountCode: null }))}>
              Remove
            </button>
          </p>
        ) : null}
        <label className="grid gap-1 text-sm">
          Order note
          <textarea value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} rows={3} className="rounded-md border border-input bg-background px-3 py-2" />
        </label>
        <dl className="grid gap-1 text-sm">
          <div className="flex justify-between">
            <dt>Subtotal</dt>
            <dd>{money(cart.subtotal)}</dd>
          </div>
          {cart.discountTotal ? (
            <div className="flex justify-between text-green-700">
              <dt>Discount</dt>
              <dd>−{money(cart.discountTotal)}</dd>
            </div>
          ) : null}
          <p className="text-muted-foreground">Shipping and taxes are calculated at checkout.</p>
        </dl>
        {error ? (
          <p role="alert" className="text-sm text-red-700">
            {error}
          </p>
        ) : null}
        <button type="button" onClick={() => void checkout()} disabled={busy} className="h-11 rounded-md bg-primary font-medium text-primary-foreground disabled:opacity-50">
          Check out
        </button>
      </aside>
    </div>
  );
}
