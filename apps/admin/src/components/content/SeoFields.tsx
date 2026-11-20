"use client";
import { Input, Label, Textarea } from "@shopkit/ui";

/** Search-engine title and description with Google-style length hints. */
export function SeoFields({ title, description, onChange, fallbackTitle, path }: { title: string; description: string; onChange: (v: { seoTitle: string; seoDescription: string }) => void; fallbackTitle: string; path: string }) {
  return (
    <fieldset className="grid gap-3 rounded-md border border-border p-3">
      <legend className="px-1 text-sm font-medium">Search engine listing</legend>
      <div className="rounded bg-muted p-2 text-sm">
        <p className="text-primary">{title || fallbackTitle}</p>
        <p className="text-xs text-muted-foreground">{path}</p>
        <p className="text-xs">{description || "Description taken from the content."}</p>
      </div>
      <div className="grid gap-1">
        <Label htmlFor="seo-title">Page title ({(title || fallbackTitle).length}/70)</Label>
        <Input id="seo-title" value={title} maxLength={120} onChange={(e) => onChange({ seoTitle: e.target.value, seoDescription: description })} />
      </div>
      <div className="grid gap-1">
        <Label htmlFor="seo-desc">Meta description ({description.length}/155)</Label>
        <Textarea id="seo-desc" rows={2} value={description} maxLength={320} onChange={(e) => onChange({ seoTitle: title, seoDescription: e.target.value })} />
      </div>
    </fieldset>
  );
}
