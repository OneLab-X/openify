import { Badge, Card, CardContent } from "@shopkit/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { serverApi } from "@/lib/api-server";

export const metadata: Metadata = { title: "Collections" };

export default async function CollectionsPage() {
  const api = await serverApi();
  const { data } = await api.GET("/api/admin/collections", { params: { query: { limit: 250, offset: 0 } } });
  if (!data) return <p>You do not have access to collections.</p>;
  return (
    <div className="grid gap-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Collections</h1>
        <Link href="/collections/new" className="rounded-md bg-primary px-4 py-2 text-sm text-primary-foreground hover:bg-primary/90">Create collection</Link>
      </div>
      <Card>
        <CardContent className="pt-6">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr><th className="p-2">Title</th><th className="p-2">Products</th><th className="p-2">Type</th><th className="p-2">Visibility</th></tr>
            </thead>
            <tbody>
              {data.map((c) => (
                <tr key={c.id} className="border-t border-border">
                  <td className="p-2"><Link href={`/collections/${c.id}`} className="font-medium hover:underline">{c.title}</Link></td>
                  <td className="p-2">{c.productsCount}</td>
                  <td className="p-2"><Badge variant="secondary">{c.type === "smart" ? "Automated" : "Manual"}</Badge></td>
                  <td className="p-2">{c.published ? "Published" : "Hidden"}</td>
                </tr>
              ))}
              {data.length === 0 ? <tr><td colSpan={4} className="p-6 text-center text-muted-foreground">No collections yet.</td></tr> : null}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
