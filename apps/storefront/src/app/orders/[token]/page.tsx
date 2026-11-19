import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { OrderDetails } from "@/components/OrderDetails";
import { ReturnRequest } from "@/components/ReturnRequest";
import { getOrderStatus, getStore } from "@/lib";

export const metadata: Metadata = { title: "Your order", robots: { index: false, follow: false } };

/**
 * Thank-you and order status page (Phase 3 item 7). The signed token in the path is the only
 * credential: no login, and no order details in the query string.
 */
export default async function OrderStatusPage({ params, searchParams }: { params: Promise<{ token: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { token } = await params;
  const isNew = (await searchParams).new === "1";
  const [order, { store }] = await Promise.all([getOrderStatus(token), getStore()]);
  if (!order) notFound();
  return (
    <main className="mx-auto max-w-3xl px-4 py-10">
      {isNew && order.placed ? (
        <div className="mb-8 grid gap-2">
          <p className="text-sm uppercase tracking-wide text-muted-foreground">Order {order.name}</p>
          <h1 className="text-3xl font-semibold">Thank you for your order!</h1>
          <p className="text-muted-foreground">{order.email ? `We've sent a confirmation to ${order.email}.` : null}</p>
        </div>
      ) : (
        <h1 className="mb-6 text-2xl font-semibold">{order.placed ? `Order ${order.name}` : "Order not placed yet"}</h1>
      )}
      <div className="grid gap-6">
        <OrderDetails order={order} locale={store?.locale ?? "en"} />
        <ReturnRequest order={order} endpoint={`/orders/${token}/returns`} />
      </div>
      <p className="mt-10">
        <Link href="/" className="underline">
          Continue shopping
        </Link>
      </p>
    </main>
  );
}
