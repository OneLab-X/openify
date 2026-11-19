"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { OrderDetails } from "@/components/OrderDetails";
import { sf, type OrderPublic } from "@/lib/shop-client";

export function AccountOrder({ id, locale }: { id: string; locale: string }) {
  const [order, setOrder] = useState<OrderPublic | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    sf<OrderPublic>("GET", `/account/orders/${id}`)
      .then(setOrder)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Could not load the order"));
  }, [id]);
  if (!order) return <p className="text-muted-foreground">{error ?? "Loading…"}</p>;
  return (
    <div className="grid gap-6">
      <Link href="/account" className="text-sm underline">
        ← Your account
      </Link>
      <h1 className="text-2xl font-semibold">Order {order.name}</h1>
      <OrderDetails order={order} locale={locale} />
    </div>
  );
}
