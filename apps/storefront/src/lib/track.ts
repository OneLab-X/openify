"use client";

/**
 * Standard ecommerce events (SPEC §12): view_item, add_to_cart, begin_checkout, purchase (+ page
 * views). Each event goes to the first-party collector and to every third-party tracker that has
 * loaded (only after consent when the tracker needs it). No cookies: the session id lives in
 * sessionStorage for the tab.
 */
export type TrackName = "page_view" | "view_item" | "view_item_list" | "add_to_cart" | "begin_checkout" | "purchase";
export interface TrackItem {
  id: string;
  name: string;
  price?: number;
  quantity?: number;
  variant?: string | null;
}
export interface TrackData {
  currency?: string;
  /** Major units (e.g. 799.00), as analytics tools expect. */
  value?: number;
  items?: TrackItem[];
  transactionId?: string;
}

type W = Window & {
  gtag?: (...a: unknown[]) => void;
  plausible?: (name: string, o?: Record<string, unknown>) => void;
  umami?: { track: (name: string, data?: Record<string, unknown>) => void };
  _paq?: unknown[][];
  posthog?: { capture: (name: string, props?: Record<string, unknown>) => void };
  fbq?: (...a: unknown[]) => void;
};

function sessionId(): string {
  try {
    let id = sessionStorage.getItem("sk_sid");
    if (!id) {
      id = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, "0")).join("");
      sessionStorage.setItem("sk_sid", id);
    }
    return id;
  } catch {
    return "nostorage00";
  }
}

const queue: { name: TrackName; path: string; data: Record<string, string | number | null> }[] = [];
let timer: ReturnType<typeof setTimeout> | null = null;
function flush() {
  timer = null;
  const events = queue.splice(0, 20);
  if (!events.length) return;
  void fetch("/api/storefront/events", {
    method: "POST",
    keepalive: true,
    headers: { "content-type": "application/json", "x-shopkit-client": "storefront" },
    body: JSON.stringify({ sessionId: sessionId(), events }),
  }).catch(() => undefined);
}

const FB: Partial<Record<TrackName, string>> = { view_item: "ViewContent", add_to_cart: "AddToCart", begin_checkout: "InitiateCheckout", purchase: "Purchase" };

export function track(name: TrackName, data: TrackData = {}) {
  if (typeof window === "undefined") return;
  queue.push({
    name,
    path: location.pathname,
    data: { ...(data.value !== undefined ? { value: data.value } : {}), ...(data.currency ? { currency: data.currency } : {}), ...(data.items?.[0] ? { item: data.items[0].id } : {}) },
  });
  if (name === "purchase" || name === "begin_checkout") flush();
  else timer ??= setTimeout(flush, 1500);
  if (name === "page_view") return; // trackers count page views themselves
  const w = window as W;
  const ga = { currency: data.currency, value: data.value, ...(data.transactionId ? { transaction_id: data.transactionId } : {}), items: data.items?.map((i) => ({ item_id: i.id, item_name: i.name, price: i.price, quantity: i.quantity ?? 1, item_variant: i.variant ?? undefined })) };
  try {
    w.gtag?.("event", name, ga);
    w.plausible?.(name, { props: { ...(data.transactionId ? { order: data.transactionId } : {}) }, ...(name === "purchase" && data.value !== undefined ? { revenue: { amount: data.value, currency: data.currency } } : {}) });
    w.umami?.track(name, { value: data.value, currency: data.currency });
    if (name === "purchase" && w._paq) {
      for (const i of data.items ?? []) w._paq.push(["addEcommerceItem", i.id, i.name, "", i.price ?? 0, i.quantity ?? 1]);
      w._paq.push(["trackEcommerceOrder", data.transactionId ?? "", data.value ?? 0]);
    } else if (name === "add_to_cart" && w._paq) w._paq.push(["trackEvent", "Ecommerce", "add_to_cart", data.items?.[0]?.name ?? "", data.value ?? 0]);
    w.posthog?.capture(name, ga);
    const fb = FB[name];
    if (fb) w.fbq?.("track", fb, { currency: data.currency, value: data.value, content_ids: data.items?.map((i) => i.id), content_type: "product" });
  } catch {
    /* a broken tracker must never break the shop */
  }
}

/** Fires once per key per tab (e.g. a purchase on a reloaded thank-you page). */
export function trackOnce(key: string, name: TrackName, data: TrackData) {
  try {
    if (sessionStorage.getItem(`sk_t_${key}`)) return;
    sessionStorage.setItem(`sk_t_${key}`, "1");
  } catch {
    /* no storage: track anyway */
  }
  track(name, data);
}
