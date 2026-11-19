import { Card, CardContent } from "@shopkit/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { serverApi } from "@/lib/api-server";
import { formatMoney } from "@/lib/money";

export const metadata: Metadata = { title: "Draft orders" };

export default async function DraftsPage() {
  const api = await serverApi();
  const { data } = await api.GET("/api/admin/draft-orders");
  if (!data) return <p>You do not have access to orders.</p>;
  return (
    <div className="grid gap-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Draft orders</h1>
        <Link href="/orders/drafts/new" className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground hover:bg-primary/90">
          Create order
        </Link>
      </div>
      <Card>
        <CardContent className="p-0">
          <table className="w-full text-sm">
            <thead className="border-b border-border text-left text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">Draft</th>
                <th className="px-4 py-2 font-medium">Customer</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 text-right font-medium">Total</th>
              </tr>
            </thead>
            <tbody>
              {data.items.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-4 py-8 text-center text-muted-foreground">
                    No drafts.
                  </td>
                </tr>
              ) : (
                data.items.map((d) => (
                  <tr key={d.id} className="border-b border-border last:border-0">
                    <td className="px-4 py-2">
                      <Link href={`/orders/drafts/${d.id}`} className="font-medium hover:underline">
                        {d.name}
                      </Link>
                    </td>
                    <td className="px-4 py-2">{d.email ?? "—"}</td>
                    <td className="px-4 py-2 capitalize">{d.status}</td>
                    <td className="px-4 py-2 text-right">{formatMoney(d.total, d.currency)}</td>
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
