"use client";
import type { Schemas } from "@shopkit/sdk";
import { Alert, Badge, Button, Card, CardContent, CardHeader, CardTitle, Checkbox, Input, Label } from "@shopkit/ui";
import { useState } from "react";
import { RichTextEditor } from "@/components/catalog/RichTextEditor";
import { api, errorMessage } from "@/lib/api-client";
import { SeoFields } from "./SeoFields";

type Page = Schemas["Page"];
const POLICIES = [
  ["privacy", "Privacy policy"],
  ["terms", "Terms of service"],
  ["shipping", "Shipping policy"],
  ["refund", "Refund policy"],
] as const;

/** Pages and the four policy pages (with generator templates). */
export function PagesManager({ initial }: { initial: Page[] }) {
  const [items, setItems] = useState(initial);
  const [editing, setEditing] = useState<Page | "new" | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const pages = items.filter((p) => p.kind === "page");
  const upsert = (p: Page) => setItems((all) => [p, ...all.filter((x) => x.id !== p.id)]);

  async function generate(type: (typeof POLICIES)[number][0], overwrite = false) {
    if (overwrite && !window.confirm("Replace the current text with the template?")) return;
    const { data, error } = await api.POST("/api/admin/policies/{type}/generate", { params: { path: { type } }, body: { overwrite } });
    if (!data) return setMsg({ ok: false, text: errorMessage(error) });
    upsert(data);
    setEditing(data);
    setMsg({ ok: true, text: `${data.title} created from the template. Review it before relying on it — it is a starting point, not legal advice.` });
  }

  return (
    <div className="grid gap-6">
      {msg ? <Alert variant={msg.ok ? "success" : "error"}>{msg.text}</Alert> : null}
      {editing ? (
        <PageEditor
          key={editing === "new" ? "new" : editing.id}
          page={editing === "new" ? null : editing}
          onCancel={() => setEditing(null)}
          onSaved={(p) => {
            upsert(p);
            setEditing(null);
            setMsg({ ok: true, text: `${p.title} saved` });
          }}
          onDeleted={(id) => {
            setItems((all) => all.filter((x) => x.id !== id));
            setEditing(null);
          }}
        />
      ) : null}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Pages</CardTitle>
          <Button size="sm" onClick={() => setEditing("new")}>
            Add page
          </Button>
        </CardHeader>
        <CardContent>
          {pages.length === 0 ? <p className="text-sm text-muted-foreground">No pages yet (About us, Contact, FAQ…).</p> : null}
          <ul className="divide-y divide-border text-sm">
            {pages.map((p) => (
              <li key={p.id} className="flex items-center justify-between gap-2 py-2">
                <button type="button" className="text-left font-medium hover:underline" onClick={() => setEditing(p)}>
                  {p.title}
                </button>
                <span className="flex items-center gap-2 text-muted-foreground">
                  {p.url} {p.published ? null : <Badge variant="outline">hidden</Badge>}
                </span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Policies</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="divide-y divide-border text-sm">
            {POLICIES.map(([type, label]) => {
              const p = items.find((x) => x.policyType === type);
              return (
                <li key={type} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span className="font-medium">{label}</span>
                  {p ? (
                    <span className="flex gap-1">
                      <Button size="sm" variant="ghost" onClick={() => setEditing(p)}>
                        Edit
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => void generate(type, true)}>
                        Reset to template
                      </Button>
                    </span>
                  ) : (
                    <Button size="sm" variant="outline" onClick={() => void generate(type)}>
                      Create from template
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}

function PageEditor({ page, onCancel, onSaved, onDeleted }: { page: Page | null; onCancel: () => void; onSaved: (p: Page) => void; onDeleted: (id: string) => void }) {
  const [f, setF] = useState({ title: page?.title ?? "", handle: page?.handle ?? "", bodyHtml: page?.bodyHtml ?? "", published: page?.published ?? true, seoTitle: page?.seoTitle ?? "", seoDescription: page?.seoDescription ?? "" });
  const [error, setError] = useState<string | null>(null);
  async function save() {
    const body = { title: f.title, ...(f.handle ? { handle: f.handle } : {}), bodyHtml: f.bodyHtml, published: f.published, seoTitle: f.seoTitle || null, seoDescription: f.seoDescription || null };
    const res = page ? await api.PUT("/api/admin/pages/{id}", { params: { path: { id: page.id } }, body }) : await api.POST("/api/admin/pages", { body });
    if (res.data) onSaved(res.data);
    else setError(errorMessage(res.error));
  }
  const prefix = page?.kind === "policy" ? "/policies/" : "/pages/";
  return (
    <Card>
      <CardHeader>
        <CardTitle>{page ? `Edit ${page.title}` : "New page"}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1">
            <Label htmlFor="pg-title">Title</Label>
            <Input id="pg-title" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="pg-handle">URL handle</Label>
            <Input id="pg-handle" value={f.handle} placeholder="made from the title" onChange={(e) => setF({ ...f, handle: e.target.value.toLowerCase() })} />
            {page && f.handle && f.handle !== page.handle ? <p className="text-xs text-muted-foreground">The old URL will redirect to the new one.</p> : null}
          </div>
        </div>
        <div className="grid gap-1">
          <span id="pg-body-label" className="text-sm font-medium">
            Content
          </span>
          <RichTextEditor id="pg-body" labelledBy="pg-body-label" value={f.bodyHtml} onChange={(bodyHtml) => setF((x) => ({ ...x, bodyHtml }))} />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={f.published} onChange={(e) => setF({ ...f, published: e.target.checked })} /> Visible on the shop
        </label>
        <SeoFields title={f.seoTitle} description={f.seoDescription} fallbackTitle={f.title} path={`${prefix}${f.handle || "…"}`} onChange={(v) => setF({ ...f, ...v })} />
        {error ? <Alert variant="error">{error}</Alert> : null}
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => void save()} disabled={!f.title.trim()}>
            Save
          </Button>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          {page ? (
            <Button
              variant="ghost"
              className="ml-auto"
              onClick={async () => {
                if (!window.confirm(`Delete ${page.title}?`)) return;
                const { error: err } = await api.DELETE("/api/admin/pages/{id}", { params: { path: { id: page.id } } });
                if (err) setError(errorMessage(err));
                else onDeleted(page.id);
              }}
            >
              Delete
            </Button>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
