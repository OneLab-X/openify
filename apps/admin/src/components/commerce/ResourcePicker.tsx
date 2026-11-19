"use client";
import { Button, Input } from "@shopkit/ui";
import { X } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { api } from "@/lib/api-client";

export type PickKind = "products" | "collections" | "customers";
type Option = { id: string; label: string };

async function search(kind: PickKind, q: string): Promise<Option[]> {
  if (kind === "products") {
    const { data } = await api.GET("/api/admin/products", { params: { query: { q, limit: 20 } } });
    return (data?.items ?? []).map((p) => ({ id: p.id, label: p.title }));
  }
  if (kind === "collections") {
    const { data } = await api.GET("/api/admin/collections", { params: { query: { q, limit: 20 } } });
    return (data ?? []).map((c) => ({ id: c.id, label: c.title }));
  }
  const { data } = await api.GET("/api/admin/customers", { params: { query: { q, limit: 20 } } });
  return (data?.items ?? []).map((c) => ({ id: c.id, label: [c.name, c.email].filter(Boolean).join(" · ") }));
}

/** Search-and-add list of products, collections or customers (ids out, names shown when known). */
export function ResourcePicker({ kind, value, onChange, label }: { kind: PickKind; value: string[]; onChange: (ids: string[]) => void; label: string }) {
  const id = useId();
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Option[]>([]);
  const [names, setNames] = useState<Record<string, string>>({});
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      void search(kind, q.trim()).then((r) => {
        if (!live) return;
        setResults(r);
        setNames((n) => ({ ...n, ...Object.fromEntries(r.map((o) => [o.id, o.label])) }));
      });
    }, 200);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [kind, q]);
  return (
    <div className="grid gap-2">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <Input id={id} type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${kind}`} autoComplete="off" />
      {results.length ? (
        <ul className="max-h-40 overflow-y-auto rounded-md border border-border text-sm" aria-label={`${kind} results`}>
          {results.map((o) => (
            <li key={o.id}>
              <button
                type="button"
                className="flex w-full items-center justify-between px-3 py-1.5 text-left hover:bg-muted disabled:opacity-50"
                disabled={value.includes(o.id)}
                onClick={() => onChange([...value, o.id])}
              >
                {o.label}
                <span className="text-xs text-muted-foreground">{value.includes(o.id) ? "Added" : "Add"}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {value.length ? (
        <ul className="flex flex-wrap gap-2">
          {value.map((v) => (
            <li key={v} className="flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs">
              {names[v] ?? `${v.slice(0, 8)}…`}
              <Button variant="ghost" size="icon" className="h-5 w-5" aria-label={`Remove ${names[v] ?? v}`} onClick={() => onChange(value.filter((x) => x !== v))}>
                <X className="h-3 w-3" />
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
