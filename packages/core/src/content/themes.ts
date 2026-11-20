import { hmacSha256Hex, safeEqual } from "@shopkit/crypto";
import { and, desc, eq, inArray, media, themeSettings, themes, themeTemplates, themeVersions, type Executor } from "@shopkit/db";
import { THEME } from "@shopkit/theme-default/schema";
import { allGlobalSettings, mapRichtext, normalizeTemplate, readSetting, TEMPLATE_NAMES, ThemeValidationError, type TemplateData, type TemplateIssue, type TemplateName } from "@shopkit/theme-sdk";
import { z } from "zod";
import { writeAudit } from "../audit.js";
import { sanitizeHtml } from "../catalog/html.js";
import { mediaView } from "../catalog/media-view.js";
import type { Actor, CoreDeps } from "../deps.js";
import { now } from "../deps.js";
import { AppError, notFound } from "../errors.js";
import { enqueueEvent } from "../outbox.js";
import { ensureDefaultMenus } from "./menus.js";

/**
 * Themes (SPEC §11). Template JSON and global settings live in the database: the editor writes a
 * draft, publishing copies drafts to live in one transaction, snapshots everything as a numbered
 * version (history and rollback) and revalidates the storefront's `theme` cache tag — no rebuild.
 */
type Templates = Record<TemplateName, TemplateData>;

async function themeRow(db: Executor, storeId: string) {
  const [t] = await db.select().from(themes).where(and(eq(themes.storeId, storeId), eq(themes.role, "main")));
  return t ?? null;
}

/** Creates the default theme (and default menus) the first time it is needed. */
export async function ensureTheme(deps: CoreDeps, storeId: string) {
  const existing = await themeRow(deps.db, storeId);
  if (existing) return existing;
  const created = await deps.db.transaction(async (tx) => {
    const [t] = await tx.insert(themes).values({ storeId, handle: THEME.handle, name: THEME.name, role: "main", publishedVersion: 1 }).onConflictDoNothing().returning();
    if (!t) return null;
    await tx.insert(themeTemplates).values(TEMPLATE_NAMES.map((name) => ({ storeId, themeId: t.id, name, published: THEME.templates[name] })));
    await tx.insert(themeSettings).values({ themeId: t.id, storeId, published: {} });
    await tx.insert(themeVersions).values({ storeId, themeId: t.id, version: 1, settings: {}, templates: THEME.templates as Record<string, Record<string, unknown>>, note: "Default theme" });
    return t;
  });
  await ensureDefaultMenus(deps, storeId);
  return created ?? (await themeRow(deps.db, storeId))!;
}

async function load(db: Executor, themeId: string) {
  const [tpls, [settings]] = await Promise.all([db.select().from(themeTemplates).where(eq(themeTemplates.themeId, themeId)), db.select().from(themeSettings).where(eq(themeSettings.themeId, themeId))]);
  return { tpls, settings: settings! };
}

/** Everything the editor needs: the draft (or live) JSON, whether a draft exists, the version list. */
export async function themeEditorState(deps: CoreDeps, storeId: string) {
  const t = await ensureTheme(deps, storeId);
  const { tpls, settings } = await load(deps.db, t.id);
  const templates = Object.fromEntries(TEMPLATE_NAMES.map((n) => [n, (tpls.find((x) => x.name === n)?.draft ?? tpls.find((x) => x.name === n)?.published ?? THEME.templates[n]) as TemplateData])) as Templates;
  const hasDraft = !!settings.draft || tpls.some((x) => x.draft);
  return {
    theme: { id: t.id, handle: t.handle, name: t.name, publishedVersion: t.publishedVersion, draftUpdatedAt: t.draftUpdatedAt?.toISOString() ?? null },
    hasDraft,
    settings: (settings.draft ?? settings.published),
    templates,
    versions: await listThemeVersions(deps.db, storeId, t.id),
  };
}

export async function listThemeVersions(db: Executor, storeId: string, themeId?: string) {
  const id = themeId ?? (await themeRow(db, storeId))?.id;
  if (!id) return [];
  const rows = await db
    .select({ version: themeVersions.version, note: themeVersions.note, publishedBy: themeVersions.publishedBy, createdAt: themeVersions.createdAt })
    .from(themeVersions)
    .where(eq(themeVersions.themeId, id))
    .orderBy(desc(themeVersions.version))
    .limit(50);
  return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
}

/** Coerces only the keys the merchant set, so unset colours keep following the brand. */
function cleanGlobalSettings(input: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const s of allGlobalSettings(THEME)) if (input[s.id] !== undefined && input[s.id] !== null) out[s.id] = readSetting(s, input[s.id]);
  return out;
}

async function sanitizeTemplate(data: TemplateData): Promise<TemplateData> {
  const html: string[] = [];
  mapRichtext(THEME, data, (h) => (html.push(h), h));
  const clean = new Map<string, string>();
  for (const h of html) clean.set(h, await sanitizeHtml(h));
  return mapRichtext(THEME, data, (h) => clean.get(h) ?? "");
}

export const themeDraftInput = z.object({
  templates: z.partialRecord(z.enum(TEMPLATE_NAMES), z.unknown()).optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
});

/** Saves editor changes as the draft. Invalid JSON is refused; unknown sections are dropped and reported. */
export async function saveThemeDraft(deps: CoreDeps, actor: Actor, storeId: string, input: z.input<typeof themeDraftInput>) {
  const d = themeDraftInput.parse(input);
  const t = await ensureTheme(deps, storeId);
  const issues: Record<string, TemplateIssue[]> = {};
  const cleaned: [TemplateName, TemplateData][] = [];
  for (const [name, raw] of Object.entries(d.templates ?? {}) as [TemplateName, unknown][]) {
    try {
      const { data, issues: found } = normalizeTemplate(THEME, name, raw);
      if (found.length) issues[name] = found;
      cleaned.push([name, await sanitizeTemplate(data)]);
    } catch (err) {
      if (err instanceof ThemeValidationError) throw new AppError("validation_failed", `${name}: ${err.message}`, err.issues);
      throw err;
    }
  }
  await deps.db.transaction(async (tx) => {
    for (const [name, data] of cleaned) await tx.update(themeTemplates).set({ draft: data }).where(and(eq(themeTemplates.themeId, t.id), eq(themeTemplates.name, name)));
    if (d.settings) await tx.update(themeSettings).set({ draft: cleanGlobalSettings(d.settings) }).where(eq(themeSettings.themeId, t.id));
    await tx.update(themes).set({ draftUpdatedAt: now(deps) }).where(eq(themes.id, t.id));
    await writeAudit(tx, actor, { storeId, action: "theme.draft_saved", resourceType: "theme", resourceId: t.id, metadata: { templates: cleaned.map(([n]) => n), settings: !!d.settings } });
  });
  return { issues };
}

export async function discardThemeDraft(deps: CoreDeps, actor: Actor, storeId: string) {
  const t = await ensureTheme(deps, storeId);
  await deps.db.transaction(async (tx) => {
    await tx.update(themeTemplates).set({ draft: null }).where(eq(themeTemplates.themeId, t.id));
    await tx.update(themeSettings).set({ draft: null }).where(eq(themeSettings.themeId, t.id));
    await tx.update(themes).set({ draftUpdatedAt: null }).where(eq(themes.id, t.id));
    await writeAudit(tx, actor, { storeId, action: "theme.draft_discarded", resourceType: "theme", resourceId: t.id });
  });
}

async function writeLive(tx: Executor, deps: CoreDeps, actor: Actor, storeId: string, themeId: string, settings: Record<string, unknown>, templates: Partial<Templates>, note: string | null) {
  const [t] = await tx.select().from(themes).where(eq(themes.id, themeId)).for("update");
  for (const [name, data] of Object.entries(templates)) await tx.update(themeTemplates).set({ published: data, draft: null }).where(and(eq(themeTemplates.themeId, themeId), eq(themeTemplates.name, name)));
  await tx.update(themeTemplates).set({ draft: null }).where(eq(themeTemplates.themeId, themeId));
  await tx.update(themeSettings).set({ published: settings, draft: null }).where(eq(themeSettings.themeId, themeId));
  const version = t!.publishedVersion + 1;
  const all = await tx.select({ name: themeTemplates.name, published: themeTemplates.published }).from(themeTemplates).where(eq(themeTemplates.themeId, themeId));
  await tx.insert(themeVersions).values({ storeId, themeId, version, settings, templates: Object.fromEntries(all.map((r) => [r.name, r.published])), note, publishedBy: actor.type === "staff" ? (actor.id ?? null) : null });
  await tx.update(themes).set({ publishedVersion: version, draftUpdatedAt: null }).where(eq(themes.id, themeId));
  await enqueueEvent(tx, { storeId, type: "theme.published", payload: { themeId, version } });
  await writeAudit(tx, actor, { storeId, action: "theme.published", resourceType: "theme", resourceId: themeId, metadata: { version, note } });
  return version;
}

/** Makes the draft live as a new version. */
export async function publishTheme(deps: CoreDeps, actor: Actor, storeId: string, input: { note?: string | null } = {}) {
  const t = await ensureTheme(deps, storeId);
  const version = await deps.db.transaction(async (tx) => {
    const { tpls, settings } = await load(tx, t.id);
    const templates = Object.fromEntries(tpls.filter((x) => x.draft).map((x) => [x.name, x.draft])) as Partial<Templates>;
    return writeLive(tx, deps, actor, storeId, t.id, (settings.draft ?? settings.published), templates, input.note?.trim().slice(0, 200) || null);
  });
  return { version };
}

/** Republishes an earlier version as a new version (history is never rewritten). */
export async function rollbackTheme(deps: CoreDeps, actor: Actor, storeId: string, version: number) {
  const t = await ensureTheme(deps, storeId);
  const [snap] = await deps.db.select().from(themeVersions).where(and(eq(themeVersions.themeId, t.id), eq(themeVersions.version, version)));
  if (!snap) throw notFound("Theme version");
  const next = await deps.db.transaction((tx) => writeLive(tx, deps, actor, storeId, t.id, snap.settings, snap.templates as unknown as Partial<Templates>, `Rollback to version ${version}`));
  return { version: next };
}

// ── Preview tokens (editor iframe sees the draft) ─────────────────────────────
const PREVIEW_TTL = 2 * 60 * 60;
export function createPreviewToken(deps: Pick<CoreDeps, "runtime" | "now">, storeId: string) {
  const exp = Math.floor(now(deps).getTime() / 1000) + PREVIEW_TTL;
  const body = `${storeId}.${exp}`;
  return `${body}.${hmacSha256Hex(deps.runtime.signingSecret, `theme-preview:${body}`).slice(0, 40)}`;
}
export function verifyPreviewToken(deps: Pick<CoreDeps, "runtime" | "now">, token: string | null | undefined): string | null {
  if (!token) return null;
  const [storeId, exp, sig] = token.split(".");
  if (!storeId || !exp || !sig || Number(exp) < now(deps).getTime() / 1000) return null;
  const expected = hmacSha256Hex(deps.runtime.signingSecret, `theme-preview:${storeId}.${exp}`).slice(0, 40);
  return safeEqual(expected, sig) ? storeId : null;
}

// ── Storefront read ─────────────────────────────────────────────────────────
/** Adds rendition sources to every image setting (`{ mediaId, url }`) found in the JSON. */
async function withImageSources<T>(deps: CoreDeps, value: T): Promise<T> {
  const ids = new Set<string>();
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (typeof o.mediaId === "string" && typeof o.url === "string") ids.add(o.mediaId);
      Object.values(o).forEach(walk);
    }
  };
  walk(value);
  const uuid = /^[0-9a-f-]{36}$/i;
  const list = [...ids].filter((i) => uuid.test(i));
  if (!list.length) return value;
  const rows = await deps.db.select().from(media).where(inArray(media.id, list));
  const views = new Map(rows.map((r) => [r.id, mediaView(deps, r)]));
  const map = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(map);
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      const m = typeof o.mediaId === "string" ? views.get(o.mediaId) : undefined;
      if (m) return { ...o, url: m.url, width: m.width, height: m.height, alt: o.alt ?? m.alt, sources: m.sources };
      return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, map(x)]));
    }
    return v;
  };
  return map(value) as T;
}

/** Live (or, for a valid preview token, draft) settings + layout + one template, render-ready. */
export async function storefrontTheme(deps: CoreDeps, storeId: string, template: TemplateName, opts: { draft?: boolean } = {}) {
  const t = await ensureTheme(deps, storeId);
  const { tpls, settings } = await load(deps.db, t.id);
  const pick = (name: TemplateName) => {
    const row = tpls.find((x) => x.name === name);
    return ((opts.draft ? row?.draft : null) ?? row?.published ?? THEME.templates[name]) as TemplateData;
  };
  return withImageSources(deps, {
    handle: t.handle,
    version: t.publishedVersion,
    draft: !!opts.draft,
    settings: ((opts.draft ? settings.draft : null) ?? settings.published),
    layout: pick("layout"),
    template: pick(template),
  });
}
