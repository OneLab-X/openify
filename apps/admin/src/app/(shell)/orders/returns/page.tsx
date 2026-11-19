import { Badge, Card, CardContent } from "@shopkit/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { human } from "@/components/commerce/badges";
import { serverApi } from "@/lib/api-server";

export const metadata: Metadata = { title: "Returns" };

const FILTERS = [
  ["", "All"],
  ["requested", "Requested"],
  ["approved", "Approved"],
  ["received", "Received"],
  ["closed", "Closed"],
] as const;

export default async function ReturnsPage({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const { status } = await searchParams;
  const valid = FILTERS.some(([v]) => v && v === status) ? (status as "requested") : undefined;
  const api = await serverApi();
  const { data } = await api.GET("/api/admin/returns", { params: { query: valid ? { status: valid } : {} } });
  if (!data) return <p>You do not have access to returns.</p>;
  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <Link href="/orders" className="text-sm text-muted-foreground hover:underline">
          ← Orders
        </Link>
        <h1 className="text-2xl font-semibold">Returns</h1>
      </div>
      <nav aria-label="Filter returns" className="flex flex-wrap gap-2 text-sm">
        {FILTERS.map(([v, label]) => (
          <Link key={v} href={v ? `/orders/returns?status=${v}` : "/orders/returns"} aria-current={(valid ?? "") === v ? "page" : undefined} className={`rounded-md px-3 py-1.5 ${(valid ?? "") === v ? "bg-muted font-medium" : "hover:bg-muted"}`}>
            {label}
          </Link>
        ))}
      </nav>
      <Card>
        <CardContent className="overflow-x-auto p-0">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">Return</th>
                <th className="px-4 py-2 font-medium">Order</th>
                <th className="px-4 py-2 font-medium">Customer</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Requested</th>
              </tr>
            </thead>
            <tbody>
              {data.items.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-8 text-center text-muted-foreground">
                    No returns.
                  </td>
                </tr>
              ) : (
                data.items.map((r) => (
                  <tr key={r.id} className="border-b border-border last:border-0">
                    <td className="px-4 py-2 font-medium">{r.name}</td>
                    <td className="px-4 py-2">
                      <Link href={`/orders/${r.orderId}`} className="hover:underline">
                        {r.orderName ?? "Order"}
                      </Link>
                    </td>
                    <td className="px-4 py-2">{r.email ?? "—"}</td>
                    <td className="px-4 py-2">
                      <Badge variant={r.status === "requested" ? "warning" : r.status === "closed" ? "success" : "secondary"}>{human(r.status)}</Badge>
                    </td>
                    <td className="px-4 py-2">
                      {new Date(r.createdAt).toLocaleDateString()} · {r.requestedBy}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
