"use client";
import { THEME } from "@shopkit/theme-default/schema";
import { findSection, newSection, sectionsFor, TEMPLATE_LABELS, TEMPLATE_NAMES, type TemplateData, type TemplateName } from "@shopkit/theme-sdk";
import type { Schemas } from "@shopkit/sdk";
import { Alert, Badge, Button, Select } from "@shopkit/ui";
import { Eye, EyeOff, Monitor, Smartphone, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SortableList } from "@/components/catalog/Sortable";
import { api, errorMessage } from "@/lib/api-client";
import { SettingField, type PickerData } from "./SettingField";

type State = Schemas["ThemeEditorState"];
type Templates = Record<TemplateName, TemplateData>;
type Selection = { kind: "theme" } | { kind: "section"; id: string } | { kind: "block"; sectionId: string; blockId: string };

const uid = () => Math.random().toString(36).slice(2, 10);
const SAVE_DELAY = 700;

/**
 * Theme editor (SPEC §11): template picker, drag-and-drop sections and blocks, settings forms
 * generated from the theme schema, a live preview of the draft in an iframe, publish, version
 * history and rollback. Every change autosaves to the draft; the live shop changes only on Publish.
 */
export function ThemeEditor({ initial, pickers, previewPaths }: { initial: State; pickers: PickerData; previewPaths: Partial<Record<TemplateName, string>> }) {
  const [templates, setTemplates] = useState<Templates>(initial.templates as Templates);
  const [settings, setSettings] = useState<Record<string, unknown>>(initial.settings);
  const [template, setTemplate] = useState<TemplateName>("index");
  const [selection, setSelection] = useState<Selection | null>(null);
  const [hasDraft, setHasDraft] = useState(initial.hasDraft);
  const [versions, setVersions] = useState(initial.versions);
  const [published, setPublished] = useState(initial.theme.publishedVersion);
  const [status, setStatus] = useState<{ kind: "idle" | "saving" | "saved" | "error"; text?: string }>({ kind: "idle" });
  const [issues, setIssues] = useState<string[]>([]);
  const [token, setToken] = useState<string | null>(null);
  const [device, setDevice] = useState<"desktop" | "mobile">("desktop");
  const [showVersions, setShowVersions] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);
  const pending = useRef<{ templates: Set<TemplateName>; settings: boolean }>({ templates: new Set(), settings: false });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef({ templates, settings });
  latest.current = { templates, settings };

  // Preview token (2 h); refreshed when the editor is reopened.
  useEffect(() => {
    void api.POST("/api/admin/theme/preview-token").then(({ data }) => data && setToken(data.token));
  }, []);

  const post = useCallback((msg: Record<string, unknown>) => frame.current?.contentWindow?.postMessage(msg, window.location.origin), []);

  const flush = useCallback(async () => {
    timer.current = null;
    const p = pending.current;
    pending.current = { templates: new Set(), settings: false };
    if (!p.templates.size && !p.settings) return;
    setStatus({ kind: "saving" });
    const body = {
      ...(p.templates.size ? { templates: Object.fromEntries([...p.templates].map((n) => [n, latest.current.templates[n]])) } : {}),
      ...(p.settings ? { settings: latest.current.settings } : {}),
    };
    const { data, error } = await api.PUT("/api/admin/theme/draft", { body });
    if (!data) {
      setStatus({ kind: "error", text: errorMessage(error) });
      return;
    }
    setIssues(Object.entries(data.issues).flatMap(([t, list]) => list.map((i) => `${TEMPLATE_LABELS[t as TemplateName] ?? t}: ${i.message}`)));
    setHasDraft(true);
    setStatus({ kind: "saved" });
    post({ type: "sk:refresh" });
  }, [post]);

  const schedule = useCallback(
    (what: { template?: TemplateName; settings?: boolean }) => {
      if (what.template) pending.current.templates.add(what.template);
      if (what.settings) pending.current.settings = true;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), SAVE_DELAY);
      setStatus({ kind: "saving" });
    },
    [flush],
  );

  const data = templates[template];
  const update = (fn: (t: TemplateData) => TemplateData) => {
    setTemplates((all) => ({ ...all, [template]: fn(structuredClone(all[template])) }));
    schedule({ template });
  };
  const allowed = useMemo(() => sectionsFor(THEME, template).filter((s) => !s.main), [template]);

  function addSection(type: string) {
    const schema = findSection(THEME, type);
    if (!schema) return;
    const id = `${type.replace(/[^a-z0-9]/g, "")}_${uid()}`;
    update((t) => {
      t.sections[id] = newSection(schema, uid);
      t.order.push(id);
      return t;
    });
    setSelection({ kind: "section", id });
  }

  async function publish() {
    if (timer.current) {
      clearTimeout(timer.current);
      await flush();
    }
    const note = window.prompt("Describe this version (optional)", "") ?? null;
    if (note === null) return;
    const { data: res, error } = await api.POST("/api/admin/theme/publish", { body: { note: note || null } });
    if (!res) return setStatus({ kind: "error", text: errorMessage(error) });
    setPublished(res.version);
    setHasDraft(false);
    setStatus({ kind: "saved", text: `Published version ${res.version}. The live shop is updated.` });
    const v = await api.GET("/api/admin/theme");
    if (v.data) setVersions(v.data.versions);
  }

  async function reload() {
    const v = await api.GET("/api/admin/theme");
    if (!v.data) return;
    setTemplates(v.data.templates as Templates);
    setSettings(v.data.settings);
    setHasDraft(v.data.hasDraft);
    setVersions(v.data.versions);
    setPublished(v.data.theme.publishedVersion);
    setSelection(null);
    post({ type: "sk:refresh" });
  }

  async function rollback(version: number) {
    if (!window.confirm(`Make version ${version} live again? Unpublished changes are discarded.`)) return;
    const { data: res, error } = await api.POST("/api/admin/theme/rollback", { body: { version } });
    if (!res) return setStatus({ kind: "error", text: errorMessage(error) });
    await reload();
    setStatus({ kind: "saved", text: `Version ${version} is live again (as version ${res.version}).` });
  }

  async function discard() {
    if (!window.confirm("Discard all unpublished changes?")) return;
    await api.DELETE("/api/admin/theme/draft");
    await reload();
    setStatus({ kind: "idle" });
  }

  const select = (s: Selection) => {
    setSelection(s);
    if (s.kind === "section") post({ type: "sk:select", id: s.id });
    if (s.kind === "block") post({ type: "sk:select", id: s.sectionId });
  };

  const path = previewPaths[template] ?? "/";
  const src = token ? `/preview?token=${encodeURIComponent(token)}&path=${encodeURIComponent(path)}` : null;

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">Theme editor</h1>
        <Badge variant="secondary">
          {initial.theme.name} · live v{published}
        </Badge>
        {hasDraft ? <Badge variant="warning">Unpublished changes</Badge> : null}
        <span role="status" className="text-sm text-muted-foreground">
          {status.kind === "saving" ? "Saving draft…" : status.kind === "saved" ? (status.text ?? "Draft saved") : ""}
        </span>
        <div className="ml-auto flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => setShowVersions(!showVersions)} aria-expanded={showVersions}>
            Versions
          </Button>
          {hasDraft ? (
            <Button variant="ghost" size="sm" onClick={() => void discard()}>
              Discard
            </Button>
          ) : null}
          <Button size="sm" onClick={() => void publish()} disabled={!hasDraft && status.kind !== "saving"}>
            Publish
          </Button>
        </div>
      </div>
      {status.kind === "error" ? <Alert variant="error">{status.text}</Alert> : null}
      {issues.length ? (
        <Alert>
          Some sections were removed because the theme doesn’t support them: {issues.join("; ")}
        </Alert>
      ) : null}
      {showVersions ? (
        <section aria-labelledby="versions-h" className="rounded-md border border-border p-3">
          <h2 id="versions-h" className="mb-2 text-sm font-medium">
            Version history
          </h2>
          <ol className="grid gap-1 text-sm">
            {versions.map((v) => (
              <li key={v.version} className="flex flex-wrap items-center justify-between gap-2">
                <span>
                  v{v.version} · {new Date(v.createdAt).toLocaleString()} {v.note ? `· ${v.note}` : ""} {v.version === published ? <Badge variant="success">live</Badge> : null}
                </span>
                {v.version !== published ? (
                  <Button size="sm" variant="ghost" onClick={() => void rollback(v.version)}>
                    Roll back to this
                  </Button>
                ) : null}
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[22rem_1fr]">
        <aside className="grid content-start gap-4" aria-label="Theme structure">
          <div className="grid gap-1">
            <label htmlFor="tpl" className="text-sm font-medium">
              Template
            </label>
            <Select
              id="tpl"
              value={template}
              onChange={(e) => {
                setTemplate(e.target.value as TemplateName);
                setSelection(null);
              }}
            >
              {TEMPLATE_NAMES.map((n) => (
                <option key={n} value={n}>
                  {TEMPLATE_LABELS[n]}
                </option>
              ))}
            </Select>
          </div>

          <div className="grid gap-2">
            <h2 className="text-sm font-medium">Sections</h2>
            <SortableList
              items={data.order.map((id) => ({ id }))}
              onChange={(next) =>
                update((t) => {
                  t.order = next.map((x) => x.id);
                  return t;
                })
              }
              className="grid gap-1"
              render={({ id }, handle) => {
                const sec = data.sections[id]!;
                const schema = findSection(THEME, sec.type);
                const active = selection?.kind !== "theme" && selection && ("id" in selection ? selection.id === id : selection.sectionId === id);
                return (
                  <div className={`flex items-center gap-1 rounded-md border px-1 py-1 text-sm ${active ? "border-primary bg-muted" : "border-border"}`} data-testid={`section-row-${sec.type}`}>
                    {handle}
                    <button type="button" className={`flex-1 truncate text-left ${sec.disabled ? "text-muted-foreground line-through" : ""}`} onClick={() => select({ kind: "section", id })}>
                      {schema?.name ?? sec.type}
                    </button>
                    {!schema?.main ? (
                      <>
                        <button
                          type="button"
                          aria-label={sec.disabled ? `Show ${schema?.name}` : `Hide ${schema?.name}`}
                          className="rounded p-1 hover:bg-background"
                          onClick={() =>
                            update((t) => {
                              t.sections[id]!.disabled = !t.sections[id]!.disabled;
                              return t;
                            })
                          }
                        >
                          {sec.disabled ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                        </button>
                        <button
                          type="button"
                          aria-label={`Remove ${schema?.name}`}
                          className="rounded p-1 hover:bg-background"
                          onClick={() => {
                            update((t) => {
                              delete t.sections[id];
                              t.order = t.order.filter((x) => x !== id);
                              return t;
                            });
                            setSelection(null);
                          }}
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </>
                    ) : null}
                  </div>
                );
              }}
            />
            {allowed.length ? (
              <Select
                aria-label="Add section"
                value=""
                onChange={(e) => {
                  if (e.target.value) addSection(e.target.value);
                }}
              >
                <option value="">+ Add section</option>
                {allowed.map((s) => (
                  <option key={s.type} value={s.type}>
                    {s.name}
                  </option>
                ))}
              </Select>
            ) : null}
          </div>

          <Button variant={selection?.kind === "theme" ? "secondary" : "outline"} onClick={() => setSelection({ kind: "theme" })}>
            Theme settings (colours, fonts, logo)
          </Button>

          {selection ? (
            <Inspector
              key={JSON.stringify(selection) + template}
              selection={selection}
              data={data}
              settings={settings}
              pickers={pickers}
              onSelect={select}
              onSettings={(next) => {
                setSettings(next);
                schedule({ settings: true });
              }}
              onTemplate={update}
            />
          ) : (
            <p className="text-sm text-muted-foreground">Choose a section to edit it, drag the handles to reorder.</p>
          )}
        </aside>

        <section aria-label="Preview" className="grid content-start gap-2">
          <div className="flex items-center justify-between gap-2 text-sm">
            <span className="truncate text-muted-foreground">Preview of the draft · {path}</span>
            <div className="flex gap-1" role="group" aria-label="Preview size">
              <Button size="icon" variant={device === "desktop" ? "secondary" : "ghost"} aria-pressed={device === "desktop"} aria-label="Desktop" onClick={() => setDevice("desktop")}>
                <Monitor className="h-4 w-4" />
              </Button>
              <Button size="icon" variant={device === "mobile" ? "secondary" : "ghost"} aria-pressed={device === "mobile"} aria-label="Mobile" onClick={() => setDevice("mobile")}>
                <Smartphone className="h-4 w-4" />
              </Button>
            </div>
          </div>
          <div className="flex justify-center rounded-md border border-border bg-muted p-2">
            {src ? (
              <iframe
                ref={frame}
                key={src}
                src={src}
                title="Storefront preview"
                className="h-[78vh] rounded bg-white shadow"
                style={{ width: device === "mobile" ? 390 : "100%" }}
                data-testid="theme-preview"
              />
            ) : (
              <p className="p-8 text-sm text-muted-foreground">Loading preview…</p>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

function Inspector({
  selection,
  data,
  settings,
  pickers,
  onSelect,
  onSettings,
  onTemplate,
}: {
  selection: Selection;
  data: TemplateData;
  settings: Record<string, unknown>;
  pickers: PickerData;
  onSelect: (s: Selection) => void;
  onSettings: (next: Record<string, unknown>) => void;
  onTemplate: (fn: (t: TemplateData) => TemplateData) => void;
}) {
  if (selection.kind === "theme") {
    return (
      <div className="grid gap-5 rounded-md border border-border p-3" aria-label="Theme settings">
        {THEME.settings.map((g) => (
          <fieldset key={g.name} className="grid gap-3">
            <legend className="mb-1 text-sm font-semibold">{g.name}</legend>
            {g.settings.map((s) => (
              <SettingField key={s.id} setting={s} value={settings[s.id]} pickers={pickers} onChange={(v) => onSettings({ ...settings, [s.id]: v })} />
            ))}
          </fieldset>
        ))}
      </div>
    );
  }
  const sectionId = selection.kind === "section" ? selection.id : selection.sectionId;
  const sec = data.sections[sectionId];
  const schema = sec ? findSection(THEME, sec.type) : undefined;
  if (!sec || !schema) return null;

  if (selection.kind === "block") {
    const block = sec.blocks[selection.blockId];
    const bs = block ? schema.blocks?.find((b) => b.type === block.type) : undefined;
    if (!block || !bs) return null;
    return (
      <div className="grid gap-3 rounded-md border border-border p-3">
        <button type="button" className="justify-self-start text-sm text-muted-foreground hover:underline" onClick={() => onSelect({ kind: "section", id: sectionId })}>
          ← {schema.name}
        </button>
        <h3 className="text-sm font-semibold">{bs.name}</h3>
        {bs.settings.map((s) => (
          <SettingField
            key={s.id}
            setting={s}
            value={block.settings[s.id]}
            pickers={pickers}
            onChange={(v) =>
              onTemplate((t) => {
                t.sections[sectionId]!.blocks[selection.blockId]!.settings[s.id] = v;
                return t;
              })
            }
          />
        ))}
        <Button
          variant="ghost"
          size="sm"
          className="justify-self-start"
          onClick={() => {
            onTemplate((t) => {
              const sct = t.sections[sectionId]!;
              delete sct.blocks[selection.blockId];
              sct.block_order = sct.block_order.filter((b) => b !== selection.blockId);
              return t;
            });
            onSelect({ kind: "section", id: sectionId });
          }}
        >
          Remove {bs.name.toLowerCase()}
        </Button>
      </div>
    );
  }

  const canAddBlock = schema.blocks?.length && (schema.maxBlocks === undefined || sec.block_order.length < schema.maxBlocks);
  return (
    <div className="grid gap-3 rounded-md border border-border p-3">
      <h3 className="text-sm font-semibold">{schema.name}</h3>
      {schema.settings.map((s) => (
        <SettingField
          key={s.id}
          setting={s}
          value={sec.settings[s.id]}
          pickers={pickers}
          onChange={(v) =>
            onTemplate((t) => {
              t.sections[sectionId]!.settings[s.id] = v;
              return t;
            })
          }
        />
      ))}
      {schema.blocks?.length ? (
        <div className="grid gap-2">
          <h4 className="text-sm font-medium">Blocks</h4>
          <SortableList
            items={sec.block_order.map((id) => ({ id }))}
            onChange={(next) =>
              onTemplate((t) => {
                t.sections[sectionId]!.block_order = next.map((x) => x.id);
                return t;
              })
            }
            className="grid gap-1"
            render={({ id }, handle) => {
              const b = sec.blocks[id]!;
              const bs = schema.blocks!.find((x) => x.type === b.type);
              const title = typeof b.settings.heading === "string" && b.settings.heading ? b.settings.heading : typeof b.settings.text === "string" && b.settings.text ? b.settings.text.replace(/<[^>]+>/g, "").slice(0, 40) : (bs?.name ?? b.type);
              return (
                <div className="flex items-center gap-1 rounded-md border border-border px-1 py-1 text-sm">
                  {handle}
                  <button type="button" className="flex-1 truncate text-left" onClick={() => onSelect({ kind: "block", sectionId, blockId: id })}>
                    {title}
                  </button>
                </div>
              );
            }}
          />
          {canAddBlock ? (
            <Select
              aria-label="Add block"
              value=""
              onChange={(e) => {
                const bs = schema.blocks!.find((b) => b.type === e.target.value);
                if (!bs) return;
                const bid = uid();
                onTemplate((t) => {
                  const sct = t.sections[sectionId]!;
                  sct.blocks[bid] = { type: bs.type, settings: {} };
                  sct.block_order.push(bid);
                  return t;
                });
                onSelect({ kind: "block", sectionId, blockId: bid });
              }}
            >
              <option value="">+ Add block</option>
              {schema.blocks.map((b) => (
                <option key={b.type} value={b.type}>
                  {b.name}
                </option>
              ))}
            </Select>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
