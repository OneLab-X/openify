import { Button, Card, CardContent, Input, Select } from "@shopkit/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { FinancialBadge, FulfillmentBadge, OrderStatusBadge } from "@/components/commerce/badges";
import { serverApi } from "@/lib/api-server";
import { formatMoney } from "@/lib/money";

export const metadata: Metadata = { title: "Orders" };

type Search = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || undefined;
const FINANCIAL = ["pending", "authorized", "paid", "partially_paid", "partially_refunded", "refunded", "voided"] as const;
const FULFILLMENT = ["unfulfilled", "partially_fulfilled", "fulfilled", "returned"] as const;
const STATUS = ["open", "closed", "cancelled"] as const;

export default async function OrdersPage({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  const financialStatus = FINANCIAL.find((s) => s === one(sp.financialStatus));
  const fulfillmentStatus = FULFILLMENT.find((s) => s === one(sp.fulfillmentStatus));
  const status = STATUS.find((s) => s === one(sp.status));
  const query = {
    ...(one(sp.q) ? { q: one(sp.q)! } : {}),
    ...(financialStatus ? { financialStatus } : {}),
    ...(fulfillmentStatus ? { fulfillmentStatus } : {}),
    ...(status ? { status } : {}),
    ...(one(sp.cursor) ? { cursor: one(sp.cursor)! } : {}),
    limit: 50,
  };
  const api = await serverApi();
  const { data } = await api.GET("/api/admin/orders", { params: { query } });
  if (!data) return <p>You do not have access to orders.</p>;
  const next = new URLSearchParams(Object.entries({ ...query, cursor: data.nextCursor ?? "" }).flatMap(([k, v]) => (k !== "limit" && v ? [[k, String(v)]] : [])));
  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">Orders</h1>
        <div className="flex gap-2">
          <Link href="/orders/drafts" className="rounded-md border border-input px-4 py-2 text-sm hover:bg-muted">
            Drafts
          </Link>
          <Link href="/orders/drafts/new" className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground hover:bg-primary/90">
            Create order
          </Link>
        </div>
      </div>
      <form className="flex flex-wrap gap-2" role="search">
        <label className="sr-only" htmlFor="order-q">
          Search orders
        </label>
        <Input id="order-q" name="q" defaultValue={query.q ?? ""} placeholder="Order number, email or name" className="w-64" />
        <Select name="financialStatus" defaultValue={financialStatus ?? ""} aria-label="Payment status" className="w-44">
          <option value="">Any payment</option>
          {FINANCIAL.map((s) => (
            <option key={s} value={s}>
              {s.replace(/_/g, " ")}
            </option>
          ))}
        </Select>
        <Select name="fulfillmentStatus" defaultValue={fulfillmentStatus ?? ""} aria-label="Fulfillment status" className="w-44">
          <option value="">Any fulfillment</option>
          {FULFILLMENT.map((s) => (
            <option key={s} value={s}>
              {s.replace(/_/g, " ")}
            </option>
          ))}
        </Select>
        <Select name="status" defaultValue={status ?? ""} aria-label="Order status" className="w-36">
          <option value="">Any status</option>
          {STATUS.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </Select>
        <Button type="submit" variant="outline">
          Filter
        </Button>
      </form>
      <Card>
        <CardContent className="overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">Order</th>
                <th className="px-4 py-2 font-medium">Date</th>
                <th className="px-4 py-2 font-medium">Customer</th>
                <th className="px-4 py-2 font-medium">Payment</th>
                <th className="px-4 py-2 font-medium">Fulfillment</th>
                <th className="px-4 py-2 text-right font-medium">Items</th>
                <th className="px-4 py-2 text-right font-medium">Total</th>
              </tr>
            </thead>
            <tbody>
              {data.items.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">
                    No orders yet.
                  </td>
                </tr>
              ) : (
                data.items.map((o) => (
                  <tr key={o.id} className="border-b border-border last:border-0 hover:bg-muted/50">
                    <td className="px-4 py-2 font-medium">
                      <Link href={`/orders/${o.id}`} className="hover:underline">
                        {o.name}
                      </Link>{" "}
                      <OrderStatusBadge status={o.status} />
                    </td>
                    <td className="px-4 py-2 text-muted-foreground">{o.placedAt ? new Date(o.placedAt).toLocaleString() : ""}</td>
                    <td className="px-4 py-2">{o.customerName ?? o.email}</td>
                    <td className="px-4 py-2">
                      <FinancialBadge status={o.financialStatus} />
                    </td>
                    <td className="px-4 py-2">
                      <FulfillmentBadge status={o.fulfillmentStatus} />
                    </td>
                    <td className="px-4 py-2 text-right">{o.itemCount}</td>
                    <td className="px-4 py-2 text-right">{formatMoney(o.total, o.currency)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>
      {data.nextCursor ? (
        <Link href={`/orders?${next.toString()}`} className="justify-self-end text-sm underline">
          Next page
        </Link>
      ) : null}
    </div>
  );
}
