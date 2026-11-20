"use client";
import type { Schemas } from "@shopkit/sdk";
import { Alert, Badge, Button, Card, CardContent, Input, Label } from "@shopkit/ui";
import { useState } from "react";
import { api, errorMessage } from "@/lib/api-client";

type Redirect = Schemas["Redirect"];

/** URL redirects: manual ones plus those created automatically when a handle changed. */
export function RedirectsManager({ initial, total: initialTotal }: { initial: Redirect[]; total: number }) {
  const [items, setItems] = useState(initial);
  const [total, setTotal] = useState(initialTotal);
  const [query, setQuery] = useState("");
  const [form, setForm] = useState({ fromPath: "", toPath: "" });
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function load(q: string) {
    setQuery(q);
    const { data } = await api.GET("/api/admin/redirects", { params: { query: { ...(q ? { query: q } : {}), limit: 100, offset: 0 } } });
    if (data) {
      setItems(data.items);
      setTotal(data.total);
    }
  }
  async function add() {
    const { data, error } = await api.POST("/api/admin/redirects", { body: form });
    if (!data) return setMsg({ ok: false, text: errorMessage(error) });
    setItems([data, ...items]);
    setTotal(total + 1);
    setForm({ fromPath: "", toPath: "" });
    setMsg({ ok: true, text: `${data.fromPath} now redirects to ${data.toPath}` });
  }
  return (
    <div className="grid gap-6">
      {msg ? <Alert variant={msg.ok ? "success" : "error"}>{msg.text}</Alert> : null}
      <Card>
        <CardContent className="grid gap-3 pt-6 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <div className="grid gap-1">
            <Label htmlFor="r-from">Redirect from</Label>
            <Input id="r-from" placeholder="/old-page" value={form.fromPath} onChange={(e) => setForm({ ...form, fromPath: e.target.value })} />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="r-to">Redirect to</Label>
            <Input id="r-to" placeholder="/collections/sale or https://…" value={form.toPath} onChange={(e) => setForm({ ...form, toPath: e.target.value })} />
          </div>
          <Button disabled={!form.fromPath || !form.toPath} onClick={() => void add()}>
            Add redirect
          </Button>
        </CardContent>
      </Card>
      <div className="grid gap-1 sm:w-72">
        <Label htmlFor="r-search">Search</Label>
        <Input id="r-search" type="search" value={query} onChange={(e) => void load(e.target.value)} />
      </div>
      <Card>
        <CardContent className="overflow-x-auto p-0">
          <table className="w-full text-sm">
            <caption className="sr-only">{total} redirects</caption>
            <thead className="border-b border-border text-left text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">From</th>
                <th className="px-4 py-2 font-medium">To</th>
                <th className="px-4 py-2">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 ? (
                <tr>
                  <td colSpan={3} className="px-4 py-6 text-center text-muted-foreground">
                    No redirects.
                  </td>
                </tr>
              ) : null}
              {items.map((r) => (
                <tr key={r.id} className="border-b border-border last:border-0">
                  <td className="px-4 py-2 font-mono">
                    {r.fromPath} {r.automatic ? <Badge variant="outline">automatic</Badge> : null}
                  </td>
                  <td className="px-4 py-2 font-mono">{r.toPath}</td>
                  <td className="px-4 py-2 text-right">
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={async () => {
                        const { error } = await api.DELETE("/api/admin/redirects/{id}", { params: { path: { id: r.id } } });
                        if (error) setMsg({ ok: false, text: errorMessage(error) });
                        else {
                          setItems(items.filter((x) => x.id !== r.id));
                          setTotal(total - 1);
                        }
                      }}
                    >
                      Delete
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
