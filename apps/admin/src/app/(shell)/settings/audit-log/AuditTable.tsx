"use client";
import type { Schemas } from "@shopkit/sdk";
import { Button } from "@shopkit/ui";
import { useState } from "react";
import { api } from "@/lib/api-client";

type Entry = Schemas["AuditEntry"];

function describe(e: Entry): string {
  const m = e.metadata as Record<string, unknown>;
  if (e.action.startsWith("credential.")) return `${String(m.kind)} · ${String(m.provider)} (${String(m.mode)})`;
  return e.resourceType ? `${e.resourceType}${e.resourceId ? ` ${e.resourceId.slice(0, 8)}` : ""}` : "";
}

export function AuditTable({ initial }: { initial: { items: Entry[]; nextCursor: string | null } }) {
  const [items, setItems] = useState(initial.items);
  const [cursor, setCursor] = useState(initial.nextCursor);
  return (
    <div className="grid gap-4">
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="text-muted-foreground">
            <tr><th className="py-2">When</th><th>Action</th><th>Details</th><th>Actor</th><th>IP</th></tr>
          </thead>
          <tbody>
            {items.map((e) => (
              <tr key={e.id} className="border-t border-border">
                <td className="whitespace-nowrap py-2">{new Date(e.createdAt).toLocaleString()}</td>
                <td><code>{e.action}</code></td>
                <td>{describe(e)}</td>
                <td>{e.actorType}</td>
                <td>{e.ip ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {cursor ? (
        <div>
          <Button variant="outline" onClick={async () => {
            const { data } = await api.GET("/api/admin/audit-logs", { params: { query: { limit: 50, cursor } } });
            if (!data) return;
            setItems((prev) => [...prev, ...data.items]);
            setCursor(data.nextCursor);
          }}>Load more</Button>
        </div>
      ) : null}
    </div>
  );
}
