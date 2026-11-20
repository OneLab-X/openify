"use client";
import { useEffect } from "react";
import { trackOnce } from "@/lib/track";

/** Thank-you page: the `purchase` event, once per order per tab (reloads don't double count). */
export function PurchaseTracker({ orderId, name, value, currency, items }: { orderId: string; name: string; value: number; currency: string; items: { id: string; name: string; price: number; quantity: number }[] }) {
  useEffect(() => {
    trackOnce(`purchase-${orderId}`, "purchase", { transactionId: name, value, currency, items });
  }, [orderId, name, value, currency, items]);
  return null;
}
