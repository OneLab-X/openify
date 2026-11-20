"use client";
import type { Schemas } from "@shopkit/sdk";
import { Alert, Button, Card, CardContent, CardHeader, CardTitle, Input, Label, Select } from "@shopkit/ui";
import { ChevronRight, Trash2 } from "lucide-react";
import { useState } from "react";
import { SortableList } from "@/components/catalog/Sortable";
import { api, errorMessage, type JsonBody } from "@/lib/api-client";

type Menu = Schemas["Menu"];
type Kind = "home" | "collection" | "product" | "page" | "policy" | "blog" | "article" | "search" | "collections" | "url";
interface Item {
  id: string;
  title: string;
  kind: Kind;
  resourceId: string | null;
  url: string | null;
  items: Item[];
}
export type Resources = Record<"collection" | "product" | "page" | "policy" | "blog" | "article", { id: string; title: string }[]>;

const KINDS: [Kind, string][] = [
  ["home", "Home page"],
  ["collections", "All collections"],
  ["collection", "Collection"],
  ["product", "Product"],
  ["page", "Page"],
  ["policy", "Policy"],
  ["blog", "Blog"],
  ["article", "Blog post"],
  ["search", "Search"],
  ["url", "Web address"],
];
const uid = () => Math.random().toString(36).slice(2, 10);
const fromApi = (items: Menu["items"] | Item[]): Item[] =>
  (items as Item[]).map((i) => ({ id: uid(), title: i.title, kind: i.kind, resourceId: i.resourceId, url: i.url, items: fromApi(i.items ?? []) }));
type Body = JsonBody<"/api/admin/menus", "post">;
const toApi = (items: Item[]): Body["items"] =>
  items.map((i) => ({ title: i.title, kind: i.kind, ...(i.resourceId ? { resourceId: i.resourceId } : {}), ...(i.kind === "url" && i.url ? { url: i.url } : {}), ...(i.items.length ? { items: toApi(i.items) as never } : {}) }));

/** Navigation menus with nested links (three levels), drag to reorder within a level. */
export function MenusManager({ initial, resources }: { initial: Menu[]; resources: Resources }) {
  const [menus, setMenus] = useState(initial);
  const [current, setCurrent] = useState<string>(initial[0]?.id ?? "new");
  const menu = menus.find((m) => m.id === current) ?? null;
  return (
    <div className="grid gap-4 lg:grid-cols-[14rem_1fr]">
      <nav aria-label="Menus" className="grid content-start gap-1">
        {menus.map((m) => (
          <button key={m.id} type="button" aria-current={m.id === current} onClick={() => setCurrent(m.id)} className={`rounded-md px-3 py-2 text-left text-sm ${m.id === current ? "bg-muted font-medium" : "hover:bg-muted"}`}>
            {m.title} <span className="block text-xs text-muted-foreground">{m.handle}</span>
          </button>
        ))}
        <Button variant="outline" size="sm" onClick={() => setCurrent("new")}>
          Add menu
        </Button>
      </nav>
      <MenuEditor
        key={current}
        menu={menu}
        resources={resources}
        onSaved={(m) => {
          setMenus((all) => [...all.filter((x) => x.id !== m.id), m].sort((a, b) => a.title.localeCompare(b.title)));
          setCurrent(m.id);
        }}
        onDeleted={(id) => {
          setMenus((all) => all.filter((x) => x.id !== id));
          setCurrent("new");
        }}
      />
    </div>
  );
}

function MenuEditor({ menu, resources, onSaved, onDeleted }: { menu: Menu | null; resources: Resources; onSaved: (m: Menu) => void; onDeleted: (id: string) => void }) {
  const [title, setTitle] = useState(menu?.title ?? "");
  const [handle, setHandle] = useState(menu?.handle ?? "");
  const [items, setItems] = useState<Item[]>(fromApi(menu?.items ?? []));
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function save() {
    const body: Body = { title, ...(handle ? { handle } : {}), items: toApi(items) };
    const res = menu ? await api.PUT("/api/admin/menus/{id}", { params: { path: { id: menu.id } }, body }) : await api.POST("/api/admin/menus", { body });
    if (!res.data) return setMsg({ ok: false, text: errorMessage(res.error) });
    setMsg({ ok: true, text: "Menu saved" });
    onSaved(res.data);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{menu ? menu.title : "New menu"}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="grid gap-1">
            <Label htmlFor="menu-title">Title</Label>
            <Input id="menu-title" value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="grid gap-1">
            <Label htmlFor="menu-handle">Handle (used by the theme)</Label>
            <Input id="menu-handle" value={handle} placeholder="main-menu" onChange={(e) => setHandle(e.target.value.toLowerCase())} />
          </div>
        </div>
        <Level items={items} onChange={setItems} depth={1} resources={resources} />
        {msg ? <Alert variant={msg.ok ? "success" : "error"}>{msg.text}</Alert> : null}
        <div className="flex gap-2">
          <Button onClick={() => void save()} disabled={!title.trim()}>
            Save menu
          </Button>
          {menu ? (
            <Button
              variant="ghost"
              className="ml-auto"
              onClick={async () => {
                if (!window.confirm(`Delete ${menu.title}? Theme sections using it show no links.`)) return;
                const { error } = await api.DELETE("/api/admin/menus/{id}", { params: { path: { id: menu.id } } });
                if (error) setMsg({ ok: false, text: errorMessage(error) });
                else onDeleted(menu.id);
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

function Level({ items, onChange, depth, resources }: { items: Item[]; onChange: (next: Item[]) => void; depth: number; resources: Resources }) {
  const set = (id: string, patch: Partial<Item>) => onChange(items.map((i) => (i.id === id ? { ...i, ...patch } : i)));
  return (
    <div className={`grid gap-2 ${depth > 1 ? "border-l border-border pl-4" : ""}`}>
      <SortableList
        items={items}
        onChange={onChange}
        className="grid gap-2"
        render={(item, handle) => {
          const list = item.kind in resources ? resources[item.kind as keyof Resources] : null;
          return (
            <div className="grid gap-2">
              <div className="flex flex-wrap items-center gap-2 rounded-md border border-border p-2">
                {handle}
                <Input aria-label="Link text" className="h-9 w-40" value={item.title} onChange={(e) => set(item.id, { title: e.target.value })} />
                <Select aria-label="Links to" className="h-9 w-40" value={item.kind} onChange={(e) => set(item.id, { kind: e.target.value as Kind, resourceId: null })}>
                  {KINDS.map(([k, label]) => (
                    <option key={k} value={k}>
                      {label}
                    </option>
                  ))}
                </Select>
                {list ? (
                  <Select aria-label="Choose item" className="h-9 min-w-40 flex-1" value={item.resourceId ?? ""} onChange={(e) => set(item.id, { resourceId: e.target.value || null, title: item.title || list.find((x) => x.id === e.target.value)?.title || "" })}>
                    <option value="">Choose…</option>
                    {list.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.title}
                      </option>
                    ))}
                  </Select>
                ) : null}
                {item.kind === "url" ? <Input aria-label="Web address" className="h-9 min-w-40 flex-1" placeholder="https:// or /path" value={item.url ?? ""} onChange={(e) => set(item.id, { url: e.target.value })} /> : null}
                {depth < 3 ? (
                  <Button size="sm" variant="ghost" onClick={() => set(item.id, { items: [...item.items, { id: uid(), title: "", kind: "url", resourceId: null, url: "", items: [] }] })}>
                    <ChevronRight className="h-4 w-4" aria-hidden /> Sub-link
                  </Button>
                ) : null}
                <Button size="icon" variant="ghost" aria-label={`Remove ${item.title || "link"}`} onClick={() => onChange(items.filter((i) => i.id !== item.id))}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
              {item.items.length ? <Level items={item.items} onChange={(next) => set(item.id, { items: next })} depth={depth + 1} resources={resources} /> : null}
            </div>
          );
        }}
      />
      <Button size="sm" variant="outline" className="justify-self-start" onClick={() => onChange([...items, { id: uid(), title: "", kind: "collection", resourceId: null, url: null, items: [] }])}>
        Add link
      </Button>
    </div>
  );
}
