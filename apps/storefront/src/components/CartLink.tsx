"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { CART_EVENT, sf, type Cart } from "@/lib/shop-client";

/** Header cart link with a live item count (updated by add-to-cart and the cart page). */
export function CartLink() {
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    sf<Cart>("GET", "/cart")
      .then((c) => alive && setCount(c.itemCount))
      .catch(() => alive && setCount(0));
    const onCart = (e: Event) => setCount((e as CustomEvent<Cart>).detail.itemCount);
    window.addEventListener(CART_EVENT, onCart);
    return () => {
      alive = false;
      window.removeEventListener(CART_EVENT, onCart);
    };
  }, []);
  return (
    <Link href="/cart" className="relative inline-flex h-9 items-center rounded-md px-2 text-sm font-medium hover:bg-muted" data-testid="cart-link">
      Cart
      {count ? (
        <span className="ml-1 rounded-full bg-primary px-2 py-0.5 text-xs text-primary-foreground" aria-label={`${count} items`}>
          {count}
        </span>
      ) : null}
    </Link>
  );
}
