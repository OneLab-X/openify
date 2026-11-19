"use client";
import type { Schemas } from "@shopkit/sdk";
import { Button, Input, Label, Select } from "@shopkit/ui";
import { useState } from "react";
import { api } from "@/lib/api-client";

type Page = Schemas["AuditPage"];
type Entry = Page["items"][number];

function describe(e: Entry): string {
  const m = e.metadata;
  if (e.action.startsWith("credential.")) return `${String(m.kind)} · ${String(m.provider)} (${String(m.mode)})`;
  return e.resourceType ? `${e.resourceType}${e.resourceId ? ` ${e.resourceId.slice(0, 8)}` : ""}` : "";
}

/** Audit log with filters (action prefix, resource, staff member, date range) and cursor paging. */
export function AuditTable({ initial, staff }: { initial: Page; staff: { id: string; name: string }[] }) {
  const [items, setItems] = useState(initial.items);
  const [cursor, setCursor] = useState(initial.nextCursor);
  const [f, setF] = useState({ action: "", resourceType: "", actorId: "", from: "", to: "" });
  const prefixes = [...new Set(initial.actions.map((a) => `${a.split(".")[0]}.`))];
  const query = (more: { cursor?: string } = {}) => ({
    limit: 50,
    ...(f.action ? { action: f.action } : {}),
    ...(f.resourceType ? { resourceType: f.resourceType } : {}),
    ...(f.actorId ? { actorId: f.actorId } : {}),
    ...(f.from ? { from: new Date(`${f.from}T00:00:00`).toISOString() } : {}),
    ...(f.to ? { to: new Date(`${f.to}T23:59:59`).toISOString() } : {}),
    ...more,
  });
  async function apply() {
    const { data } = await api.GET("/api/admin/audit", { params: { query: query() } });
    if (!data) return;
    setItems(data.items);
    setCursor(data.nextCursor);
  }
  return (
    <div className="grid gap-4">
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void apply();
        }}
      >
        <div className="grid gap-1">
          <Label htmlFor="a-action">Action</Label>
          <Select id="a-action" value={f.action} onChange={(e) => setF({ ...f, action: e.target.value })}>
            <option value="">All</option>
            {prefixes.map((p) => (
              <option key={p} value={p}>
                {p.slice(0, -1)}
              </option>
            ))}
          </Select>
        </div>
        <div className="grid gap-1">
          <Label htmlFor="a-res">Resource type</Label>
          <Input id="a-res" className="w-36" value={f.resourceType} onChange={(e) => setF({ ...f, resourceType: e.target.value })} placeholder="order" />
        </div>
        <div className="grid gap-1">
          <Label htmlFor="a-actor">Staff</Label>
          <Select id="a-actor" value={f.actorId} onChange={(e) => setF({ ...f, actorId: e.target.value })}>
            <option value="">Anyone</option>
            {staff.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </div>
        <div className="grid gap-1">
          <Label htmlFor="a-from">From</Label>
          <Input id="a-from" type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} />
        </div>
        <div className="grid gap-1">
          <Label htmlFor="a-to">To</Label>
          <Input id="a-to" type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} />
        </div>
        <Button type="submit" variant="outline">
          Filter
        </Button>
      </form>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="text-muted-foreground">
            <tr>
              <th className="py-2 font-medium">When</th>
              <th className="font-medium">Action</th>
              <th className="font-medium">Details</th>
              <th className="font-medium">Who</th>
              <th className="font-medium">IP</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
              <tr>
                <td colSpan={5} className="py-6 text-center text-muted-foreground">
                  Nothing matches these filters.
                </td>
              </tr>
            ) : null}
            {items.map((e) => (
              <tr key={e.id} className="border-t border-border">
                <td className="whitespace-nowrap py-2">{new Date(e.createdAt).toLocaleString()}</td>
                <td>
                  <code>{e.action}</code>
                </td>
                <td>{describe(e)}</td>
                <td>{e.actorName ?? e.actorType}</td>
                <td>{e.ip ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {cursor ? (
        <div>
          <Button
            variant="outline"
            onClick={async () => {
              const { data } = await api.GET("/api/admin/audit", { params: { query: query({ cursor }) } });
              if (!data) return;
              setItems((prev) => [...prev, ...data.items]);
              setCursor(data.nextCursor);
            }}
          >
            Load more
          </Button>
        </div>
      ) : null}
    </div>
  );
}
