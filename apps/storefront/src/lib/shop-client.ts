"use client";
import type { Schemas } from "@shopkit/sdk";

/** Browser-side calls to the Storefront API (same origin through Caddy, cookies included). */
export type Cart = Schemas["Cart"];
export type CartLine = Schemas["CartLine"];
export type Checkout = Schemas["Checkout"];
export type PaymentSession = Schemas["PaymentSession"];
export type VerifyResult = Schemas["PaymentVerifyResult"];
export type OrderPublic = Schemas["OrderPublic"];
export type Customer = Schemas["Customer"];
export type MailingAddress = Schemas["MailingAddress"];

export class ShopError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

/**
 * JSON request to /api/storefront. The X-Shopkit-Client header is what the API checks on every
 * cookie-authenticated write (CSRF): cross-site pages cannot send it.
 */
export async function sf<T>(method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/storefront${path}`, {
      method,
      credentials: "same-origin",
      cache: "no-store",
      headers: { "x-shopkit-client": "storefront", ...(body !== undefined ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new ShopError("Can't reach the shop. Check your connection and try again.", 0);
  }
  const data = (await res.json().catch(() => null)) as ({ error?: { message: string; details?: unknown } } & T) | null;
  if (!res.ok) throw new ShopError(data?.error?.message ?? `Something went wrong (${res.status})`, res.status, data?.error?.details);
  return data as T;
}

export const CART_EVENT = "shopkit:cart";
export function announceCart(cart: Cart) {
  window.dispatchEvent(new CustomEvent<Cart>(CART_EVENT, { detail: cart }));
}

const scripts = new Map<string, Promise<void>>();
/** Loads a provider script once (Razorpay, Stripe.js, Cashfree). */
export function loadScript(src: string): Promise<void> {
  let p = scripts.get(src);
  if (!p) {
    p = new Promise<void>((resolve, reject) => {
      const el = document.createElement("script");
      el.src = src;
      el.async = true;
      el.onload = () => resolve();
      el.onerror = () => {
        scripts.delete(src);
        el.remove();
        reject(new Error("Couldn't load the payment window. Check your connection and try again."));
      };
      document.head.appendChild(el);
    });
    scripts.set(src, p);
  }
  return p;
}
