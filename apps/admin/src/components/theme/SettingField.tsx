"use client";
import { FONTS, readSetting, type ImageValue, type SettingSchema } from "@shopkit/theme-sdk";
import { Button, Checkbox, Input, Select, Textarea } from "@shopkit/ui";
import { useId, useState } from "react";
import { RichTextEditor } from "@/components/catalog/RichTextEditor";
import { uploadImage } from "@/lib/media-upload";

export interface PickerData {
  products: { handle: string; title: string }[];
  collections: { handle: string; title: string }[];
  menus: { handle: string; title: string }[];
}

/** One form control generated from a theme setting's schema (SPEC §11 "settings forms from schema"). */
export function SettingField({ setting: s, value, onChange, pickers }: { setting: SettingSchema; value: unknown; onChange: (v: unknown) => void; pickers: PickerData }) {
  const id = useId();
  const labelId = `${id}-label`;
  const current = readSetting(s, value);
  const info = s.info ? (
    <p id={`${id}-info`} className="text-xs text-muted-foreground">
      {s.info}
    </p>
  ) : null;
  const described = s.info ? `${id}-info` : undefined;
  const label = (
    <label id={labelId} htmlFor={id} className="text-sm font-medium">
      {s.label}
    </label>
  );

  switch (s.type) {
    case "boolean":
      return (
        <div className="grid gap-1">
          <label className="flex items-center gap-2 text-sm font-medium">
            <Checkbox id={id} checked={current === true} onChange={(e) => onChange(e.target.checked)} aria-describedby={described} /> {s.label}
          </label>
          {info}
        </div>
      );
    case "text":
    case "url":
      return (
        <div className="grid gap-1">
          {label}
          <Input id={id} type={s.type === "url" ? "text" : "text"} inputMode={s.type === "url" ? "url" : undefined} value={typeof value === "string" ? value : ((current as string | null) ?? "")} placeholder={s.type === "url" ? "/collections/sale or https://…" : (s.placeholder ?? "")} maxLength={s.type === "text" ? s.maxLength : 2000} onChange={(e) => onChange(e.target.value)} aria-describedby={described} />
          {info}
        </div>
      );
    case "textarea":
      return (
        <div className="grid gap-1">
          {label}
          <Textarea id={id} rows={3} value={typeof value === "string" ? value : ((current as string | null) ?? "")} maxLength={s.maxLength} onChange={(e) => onChange(e.target.value)} aria-describedby={described} />
          {info}
        </div>
      );
    case "richtext":
      return (
        <div className="grid gap-1">
          <span id={labelId} className="text-sm font-medium">
            {s.label}
          </span>
          <RichTextEditor id={id} labelledBy={labelId} value={(current as string | null) ?? ""} onChange={onChange} />
          {info}
        </div>
      );
    case "color":
      return (
        <div className="grid gap-1">
          {label}
          <div className="flex items-center gap-2">
            <input type="color" aria-label={`${s.label} picker`} value={current as string} onChange={(e) => onChange(e.target.value)} className="h-10 w-12 cursor-pointer rounded border border-input bg-background" />
            <Input id={id} value={typeof value === "string" ? value : (current as string)} onChange={(e) => onChange(e.target.value)} className="w-32 font-mono" aria-describedby={described} />
          </div>
          {info}
        </div>
      );
    case "font":
      return (
        <div className="grid gap-1">
          {label}
          <Select id={id} value={current as string} onChange={(e) => onChange(e.target.value)} aria-describedby={described}>
            {Object.entries(FONTS).map(([k, f]) => (
              <option key={k} value={k} style={{ fontFamily: f.stack }}>
                {f.label}
              </option>
            ))}
          </Select>
          {info}
        </div>
      );
    case "range":
      return (
        <div className="grid gap-1">
          <div className="flex justify-between">
            {label}
            <output htmlFor={id} className="text-sm tabular-nums text-muted-foreground">
              {String(current)}
              {s.unit ?? ""}
            </output>
          </div>
          <input id={id} type="range" min={s.min} max={s.max} step={s.step ?? 1} value={current as number} onChange={(e) => onChange(Number(e.target.value))} className="accent-primary" aria-describedby={described} />
          {info}
        </div>
      );
    case "select":
      return (
        <div className="grid gap-1">
          {label}
          <Select id={id} value={current as string} onChange={(e) => onChange(e.target.value)} aria-describedby={described}>
            {s.options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>
          {info}
        </div>
      );
    case "product":
    case "collection":
    case "menu": {
      const list = s.type === "product" ? pickers.products : s.type === "collection" ? pickers.collections : pickers.menus;
      return (
        <div className="grid gap-1">
          {label}
          <Select id={id} value={(current as string | null) ?? ""} onChange={(e) => onChange(e.target.value || null)} aria-describedby={described}>
            <option value="">{s.type === "menu" ? "No menu" : "Choose…"}</option>
            {list.map((o) => (
              <option key={o.handle} value={o.handle}>
                {o.title}
              </option>
            ))}
          </Select>
          {info}
        </div>
      );
    }
    case "image":
      return <ImageField id={id} label={s.label} value={current as ImageValue | null} onChange={onChange} info={info} />;
  }
}

function ImageField({ id, label, value, onChange, info }: { id: string; label: string; value: ImageValue | null; onChange: (v: unknown) => void; info: React.ReactNode }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="grid gap-1">
      <span className="text-sm font-medium" id={`${id}-l`}>
        {label}
      </span>
      {value ? (
        <div className="grid gap-2">
          <img src={value.url} alt="" className="max-h-32 w-auto rounded border border-border object-contain" />
          <Input aria-label={`${label} alt text`} placeholder="Alt text (describe the image)" value={value.alt ?? ""} onChange={(e) => onChange({ ...value, alt: e.target.value })} />
        </div>
      ) : null}
      <div className="flex gap-2">
        <label className="inline-flex h-9 cursor-pointer items-center rounded-md border border-input px-3 text-sm hover:bg-muted">
          {busy ? "Uploading…" : value ? "Replace image" : "Upload image"}
          <input
            id={id}
            type="file"
            accept="image/*"
            className="sr-only"
            aria-labelledby={`${id}-l`}
            disabled={busy}
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              setBusy(true);
              setError(null);
              try {
                const m = await uploadImage(file);
                onChange({ mediaId: m.id, url: m.url, alt: m.alt ?? "", width: m.width, height: m.height });
              } catch (err) {
                setError(err instanceof Error ? err.message : "Upload failed");
              } finally {
                setBusy(false);
                e.target.value = "";
              }
            }}
          />
        </label>
        {value ? (
          <Button size="sm" variant="ghost" onClick={() => onChange(null)}>
            Remove
          </Button>
        ) : null}
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      {info}
    </div>
  );
}
