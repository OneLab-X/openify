import { Button, Card, CardContent, Input, Select } from "@shopkit/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { serverApi } from "@/lib/api-server";
import { formatMoney } from "@/lib/money";

export const metadata: Metadata = { title: "Customers" };

type Search = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || undefined;

export default async function CustomersPage({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  const sort = one(sp.sort) === "spent_desc" ? ("spent_desc" as const) : ("created_desc" as const);
  const query = { ...(one(sp.q) ? { q: one(sp.q)! } : {}), ...(one(sp.tag) ? { tag: one(sp.tag)! } : {}), sort, ...(one(sp.cursor) ? { cursor: one(sp.cursor)! } : {}), limit: 50 };
  const api = await serverApi();
  const { data } = await api.GET("/api/admin/customers", { params: { query } });
  if (!data) return <p>You do not have access to customers.</p>;
  const next = new URLSearchParams(Object.entries({ ...query, cursor: data.nextCursor ?? "" }).flatMap(([k, v]) => (k !== "limit" && v ? [[k, String(v)]] : [])));
  return (
    <div className="grid gap-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Customers</h1>
        <Link href="/customers/new" className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground hover:bg-primary/90">
          Add customer
        </Link>
      </div>
      <form className="flex flex-wrap gap-2" role="search">
        <label htmlFor="cust-q" className="sr-only">
          Search customers
        </label>
        <Input id="cust-q" name="q" defaultValue={query.q ?? ""} placeholder="Name, email or phone" className="w-64" />
        <Input name="tag" defaultValue={query.tag ?? ""} placeholder="Tag" aria-label="Tag" className="w-32" />
        <Select name="sort" defaultValue={sort} aria-label="Sort" className="w-48">
          <option value="created_desc">Newest first</option>
          <option value="spent_desc">Highest lifetime value</option>
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
                <th className="px-4 py-2 font-medium">Customer</th>
                <th className="px-4 py-2 font-medium">Email subscription</th>
                <th className="px-4 py-2 text-right font-medium">Orders</th>
                <th className="px-4 py-2 text-right font-medium">Amount spent</th>
              </tr>
            </thead>
            <tbody>
              {data.items.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-4 py-8 text-center text-muted-foreground">
                    No customers yet.
                  </td>
                </tr>
              ) : (
                data.items.map((c) => (
                  <tr key={c.id} className="border-b border-border last:border-0 hover:bg-muted/50">
                    <td className="px-4 py-2">
                      <Link href={`/customers/${c.id}`} className="font-medium hover:underline">
                        {c.name ?? c.email}
                      </Link>
                      {c.name ? <span className="block text-xs text-muted-foreground">{c.email}</span> : null}
                    </td>
                    <td className="px-4 py-2">{c.marketingConsent ? "Subscribed" : "Not subscribed"}</td>
                    <td className="px-4 py-2 text-right">{c.ordersCount}</td>
                    <td className="px-4 py-2 text-right">{c.currency ? formatMoney(c.totalSpent, c.currency) : "—"}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </CardContent>
      </Card>
      {data.nextCursor ? (
        <Link href={`/customers?${next.toString()}`} className="justify-self-end text-sm underline">
          Next page
        </Link>
      ) : null}
    </div>
  );
}
