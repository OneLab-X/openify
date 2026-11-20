import { z } from "zod";

/**
 * Theme SDK (SPEC §11): the schema language a theme uses to describe its sections, blocks and
 * settings, the template JSON the theme editor writes, and helpers that read settings with
 * defaults. Framework-free so the API (validation), admin (forms) and storefront (rendering) share it.
 */

// ── Settings ─────────────────────────────────────────────────────────────────
interface Base {
  id: string;
  label: string;
  info?: string;
}
export interface TextSetting extends Base {
  type: "text";
  default?: string;
  placeholder?: string;
  maxLength?: number;
}
export interface TextareaSetting extends Base {
  type: "textarea";
  default?: string;
  maxLength?: number;
}
export interface RichtextSetting extends Base {
  type: "richtext";
  default?: string;
}
export interface ImageSetting extends Base {
  type: "image";
}
export interface ColorSetting extends Base {
  type: "color";
  default: string;
}
export interface FontSetting extends Base {
  type: "font";
  default: FontId;
}
export interface RangeSetting extends Base {
  type: "range";
  min: number;
  max: number;
  step?: number;
  unit?: string;
  default: number;
}
export interface SelectSetting extends Base {
  type: "select";
  options: { value: string; label: string }[];
  default: string;
}
export interface ProductSetting extends Base {
  type: "product";
}
export interface CollectionSetting extends Base {
  type: "collection";
}
export interface MenuSetting extends Base {
  type: "menu";
  default?: string;
}
export interface UrlSetting extends Base {
  type: "url";
  default?: string;
}
export interface BooleanSetting extends Base {
  type: "boolean";
  default: boolean;
}
export type SettingSchema =
  | TextSetting
  | TextareaSetting
  | RichtextSetting
  | ImageSetting
  | ColorSetting
  | FontSetting
  | RangeSetting
  | SelectSetting
  | ProductSetting
  | CollectionSetting
  | MenuSetting
  | UrlSetting
  | BooleanSetting;
export type SettingType = SettingSchema["type"];

/** An image chosen in the editor: a media id plus what the storefront needs to render it. */
export interface ImageValue {
  mediaId: string;
  url: string;
  alt?: string | null;
  width?: number | null;
  height?: number | null;
}

/** Value type of each setting kind after defaults are applied. */
export type SettingValueOf<S extends SettingSchema> = S extends { type: "range" }
  ? number
  : S extends { type: "boolean" }
    ? boolean
    : S extends { type: "image" }
      ? ImageValue | null
      : S extends { type: "product" | "collection" | "menu" | "url" | "richtext" | "text" | "textarea" }
        ? S extends { default: string }
          ? string
          : string | null
        : string;

export type SettingsValues<T extends readonly SettingSchema[]> = { [S in T[number] as S["id"]]: SettingValueOf<S> };

/**
 * Fonts are system stacks (no web-font download), so the default theme stays fast on mobile and
 * needs no third-party request before consent.
 */
export const FONTS = {
  system: { label: "System sans", stack: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif' },
  humanist: { label: "Humanist", stack: 'Seravek, "Gill Sans Nova", Ubuntu, Calibri, "DejaVu Sans", source-sans-pro, sans-serif' },
  geometric: { label: "Geometric", stack: 'Avenir, Montserrat, Corbel, "URW Gothic", source-sans-pro, sans-serif' },
  serif: { label: "Transitional serif", stack: 'Charter, "Bitstream Charter", "Sitka Text", Cambria, serif' },
  oldstyle: { label: "Old-style serif", stack: '"Iowan Old Style", "Palatino Linotype", "URW Palladio L", P052, serif' },
  mono: { label: "Monospace", stack: 'ui-monospace, "Cascadia Code", "Source Code Pro", Menlo, Consolas, monospace' },
} as const;
export type FontId = keyof typeof FONTS;
export const fontStack = (id: string) => (FONTS as Record<string, { stack: string }>)[id]?.stack ?? FONTS.system.stack;

// ── Sections and blocks ──────────────────────────────────────────────────────
export interface BlockSchema {
  type: string;
  name: string;
  settings: readonly SettingSchema[];
}

export interface SectionSchema {
  type: string;
  name: string;
  settings: readonly SettingSchema[];
  blocks?: readonly BlockSchema[];
  maxBlocks?: number;
  /** Templates this section may be added to (default: all except "layout"). */
  templates?: readonly TemplateName[];
  /** Exactly one per template and cannot be removed (the template's main content). */
  main?: boolean;
  /** Default blocks when the merchant adds the section. */
  presetBlocks?: readonly { type: string; settings?: Record<string, unknown> }[];
}

export const TEMPLATE_NAMES = ["layout", "index", "collection", "product", "cart", "search", "page", "blog", "article", "account", "404"] as const;
export type TemplateName = (typeof TEMPLATE_NAMES)[number];
export const TEMPLATE_LABELS: Record<TemplateName, string> = {
  layout: "Header & footer",
  index: "Home page",
  collection: "Collection",
  product: "Product",
  cart: "Cart",
  search: "Search",
  page: "Page",
  blog: "Blog",
  article: "Blog post",
  account: "Customer account",
  "404": "Page not found",
};

export interface SettingGroup {
  name: string;
  settings: readonly SettingSchema[];
}

export interface ThemeSchema {
  handle: string;
  name: string;
  version: string;
  settings: readonly SettingGroup[];
  sections: readonly SectionSchema[];
  /** Initial template JSON for every template. */
  templates: Record<TemplateName, TemplateData>;
}

// ── Template JSON ────────────────────────────────────────────────────────────
const id = z.string().regex(/^[a-z0-9_-]{1,64}$/i);
const settingsRecord = z.record(z.string().max(64), z.unknown());
export const blockData = z.object({ type: z.string().max(64), disabled: z.boolean().optional(), settings: settingsRecord.default({}) });
export const sectionData = z.object({
  type: z.string().max(64),
  disabled: z.boolean().optional(),
  settings: settingsRecord.default({}),
  blocks: z.record(id, blockData).default({}),
  block_order: z.array(id).max(50).default([]),
});
export const templateData = z.object({
  sections: z.record(id, sectionData),
  order: z.array(id).max(40),
});
export type BlockData = z.infer<typeof blockData>;
export type SectionData = z.infer<typeof sectionData>;
export type TemplateData = z.infer<typeof templateData>;

// ── Reading settings ─────────────────────────────────────────────────────────
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** One value coerced to its setting type; anything invalid becomes the default. */
export function readSetting(s: SettingSchema, raw: unknown): unknown {
  const fallback = "default" in s && s.default !== undefined ? s.default : null;
  switch (s.type) {
    case "text":
    case "textarea": {
      if (typeof raw !== "string") return fallback;
      return s.maxLength ? raw.slice(0, s.maxLength) : raw;
    }
    case "richtext":
      return typeof raw === "string" ? raw : fallback;
    case "color":
      return typeof raw === "string" && /^#[0-9a-f]{6}$/i.test(raw) ? raw.toLowerCase() : s.default;
    case "font":
      return typeof raw === "string" && raw in FONTS ? raw : s.default;
    case "range": {
      const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : Number.NaN;
      if (!Number.isFinite(n)) return s.default;
      const step = s.step ?? 1;
      const clamped = Math.min(s.max, Math.max(s.min, n));
      return Math.round((clamped - s.min) / step) * step + s.min;
    }
    case "select":
      return typeof raw === "string" && s.options.some((o) => o.value === raw) ? raw : s.default;
    case "boolean":
      return typeof raw === "boolean" ? raw : s.default;
    case "image":
      return isRecord(raw) && typeof raw.mediaId === "string" && typeof raw.url === "string" && /^(\/|https:\/\/)/.test(raw.url)
        ? {
            mediaId: raw.mediaId,
            url: raw.url,
            alt: typeof raw.alt === "string" ? raw.alt : null,
            width: typeof raw.width === "number" ? raw.width : null,
            height: typeof raw.height === "number" ? raw.height : null,
          }
        : null;
    case "url":
      return typeof raw === "string" && /^(\/(?!\/)|https?:\/\/|mailto:|tel:)/i.test(raw.trim()) ? raw.trim() : fallback;
    case "product":
    case "collection":
    case "menu":
      return typeof raw === "string" && /^[\p{L}\p{N}][\p{L}\p{N}_-]{0,199}$/u.test(raw) ? raw.toLowerCase() : fallback;
  }
}

/** Settings object with every schema key present (defaults applied, unknown keys dropped). */
export function readSettings<T extends readonly SettingSchema[]>(schema: T, values: unknown): SettingsValues<T> {
  const src = isRecord(values) ? values : {};
  const out: Record<string, unknown> = {};
  for (const s of schema) out[s.id] = readSetting(s, src[s.id]);
  return out as SettingsValues<T>;
}

/** Defaults only (what a newly added section or block starts with). */
export const defaultSettings = <T extends readonly SettingSchema[]>(schema: T) => readSettings(schema, {});

export const allGlobalSettings = (theme: Pick<ThemeSchema, "settings">) => theme.settings.flatMap((g) => g.settings);

export function findSection(theme: Pick<ThemeSchema, "sections">, type: string) {
  return theme.sections.find((s) => s.type === type);
}

/** Section types allowed in a template. */
export function sectionsFor(theme: Pick<ThemeSchema, "sections">, template: TemplateName) {
  return theme.sections.filter((s) => (s.templates ? s.templates.includes(template) : template !== "layout"));
}

export interface TemplateIssue {
  path: string;
  message: string;
}

/**
 * Validates and normalises template JSON against the theme: unknown section/block types and
 * orphaned ids are dropped, block limits enforced, main sections required, settings coerced.
 * Returns the cleaned template plus anything that was dropped (the editor shows it).
 */
export function normalizeTemplate(theme: Pick<ThemeSchema, "sections">, template: TemplateName, input: unknown): { data: TemplateData; issues: TemplateIssue[] } {
  const issues: TemplateIssue[] = [];
  const parsed = templateData.safeParse(input);
  if (!parsed.success) throw new ThemeValidationError(parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
  const allowed = sectionsFor(theme, template);
  const sections: Record<string, SectionData> = {};
  const order: string[] = [];
  for (const key of parsed.data.order) {
    const sec = parsed.data.sections[key];
    if (!sec || order.includes(key)) {
      issues.push({ path: `order.${key}`, message: "Unknown or duplicate section id" });
      continue;
    }
    const schema = allowed.find((s) => s.type === sec.type);
    if (!schema) {
      issues.push({ path: `sections.${key}`, message: `Section type "${sec.type}" is not available here` });
      continue;
    }
    const blocks: Record<string, BlockData> = {};
    const blockOrder: string[] = [];
    for (const bid of sec.block_order) {
      const b = sec.blocks[bid];
      const bs = b && schema.blocks?.find((x) => x.type === b.type);
      if (!b || !bs || blockOrder.includes(bid)) {
        issues.push({ path: `sections.${key}.blocks.${bid}`, message: "Unknown block" });
        continue;
      }
      if (schema.maxBlocks !== undefined && blockOrder.length >= schema.maxBlocks) {
        issues.push({ path: `sections.${key}.blocks.${bid}`, message: `At most ${schema.maxBlocks} blocks` });
        continue;
      }
      blocks[bid] = { type: b.type, ...(b.disabled ? { disabled: true } : {}), settings: readSettings(bs.settings, b.settings) };
      blockOrder.push(bid);
    }
    sections[key] = { type: sec.type, ...(sec.disabled && !schema.main ? { disabled: true } : {}), settings: readSettings(schema.settings, sec.settings), blocks, block_order: blockOrder };
    order.push(key);
  }
  for (const main of allowed.filter((s) => s.main)) {
    const count = order.filter((k) => sections[k]!.type === main.type).length;
    if (count !== 1) throw new ThemeValidationError([{ path: "order", message: `The template needs exactly one "${main.name}" section` }]);
  }
  return { data: { sections, order }, issues };
}

export class ThemeValidationError extends Error {
  constructor(readonly issues: TemplateIssue[]) {
    super(issues[0]?.message ?? "Invalid template");
    this.name = "ThemeValidationError";
  }
}

/** Every richtext setting value in a template (the server sanitises them on save). */
export function mapRichtext(theme: Pick<ThemeSchema, "sections">, data: TemplateData, fn: (html: string) => string): TemplateData {
  const map = (schema: readonly SettingSchema[], values: Record<string, unknown>) => {
    const out = { ...values };
    for (const s of schema) if (s.type === "richtext" && typeof out[s.id] === "string") out[s.id] = fn(out[s.id] as string);
    return out;
  };
  const sections: Record<string, SectionData> = {};
  for (const [key, sec] of Object.entries(data.sections)) {
    const schema = findSection(theme, sec.type);
    if (!schema) continue;
    const blocks: Record<string, BlockData> = {};
    for (const [bid, b] of Object.entries(sec.blocks)) {
      const bs = schema.blocks?.find((x) => x.type === b.type);
      blocks[bid] = bs ? { ...b, settings: map(bs.settings, b.settings) } : b;
    }
    sections[key] = { ...sec, settings: map(schema.settings, sec.settings), blocks };
  }
  return { sections, order: data.order };
}

/** Resolved, render-ready view of a section. */
export interface ResolvedBlock {
  id: string;
  type: string;
  settings: Record<string, unknown>;
}
export interface ResolvedSection {
  id: string;
  type: string;
  settings: Record<string, unknown>;
  blocks: ResolvedBlock[];
}

/** Visible sections of a template in order, with defaults applied (what the storefront renders). */
export function resolveTemplate(theme: Pick<ThemeSchema, "sections">, data: TemplateData): ResolvedSection[] {
  const out: ResolvedSection[] = [];
  for (const key of data.order) {
    const sec = data.sections[key];
    const schema = sec && findSection(theme, sec.type);
    if (!sec || !schema || sec.disabled) continue;
    out.push({
      id: key,
      type: sec.type,
      settings: readSettings(schema.settings, sec.settings),
      blocks: sec.block_order
        .map((bid) => ({ bid, b: sec.blocks[bid] }))
        .filter((x): x is { bid: string; b: BlockData } => !!x.b && !x.b.disabled)
        .map(({ bid, b }) => {
          const bs = schema.blocks?.find((s) => s.type === b.type);
          return { id: bid, type: b.type, settings: bs ? readSettings(bs.settings, b.settings) : {} };
        }),
    });
  }
  return out;
}

/** A fresh section instance (editor "Add section"). */
export function newSection(schema: SectionSchema, makeId: () => string): SectionData {
  const blocks: Record<string, BlockData> = {};
  const order: string[] = [];
  for (const p of schema.presetBlocks ?? []) {
    const bs = schema.blocks?.find((b) => b.type === p.type);
    if (!bs) continue;
    const bid = makeId();
    blocks[bid] = { type: p.type, settings: readSettings(bs.settings, p.settings ?? {}) };
    order.push(bid);
  }
  return { type: schema.type, settings: defaultSettings(schema.settings), blocks, block_order: order };
}
