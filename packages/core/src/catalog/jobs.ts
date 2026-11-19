import { buffer as readAll } from "node:stream/consumers";
import { and, desc, eq, jobsLog, media, ne, providerCredentials, sql, uuidv7, type JobError } from "@shopkit/db";
import type { StorageProvider } from "@shopkit/providers";
import { writeAudit } from "../audit.js";
import { loadProvider } from "../credentials.js";
import type { Actor, CoreDeps } from "../deps.js";
import { AppError, notFound } from "../errors.js";
import { activeStorage } from "../media.js";
import { enqueueEvent } from "../outbox.js";
import { getSetting, setSetting } from "../settings.js";
import { getStore } from "../stores.js";
import { exportShopifyCsv, importParsedProduct, parseShopifyCsv } from "./csv.js";
import { productListQuery } from "./products.js";

type JobType = "product_import" | "product_export" | "media_migration";
type JobRow = typeof jobsLog.$inferSelect;
const MAX_ERRORS = 1000;

export function jobView(row: JobRow) {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    processed: row.processed,
    total: row.total,
    errorCount: row.errorCount,
    result: row.result,
    filename: typeof row.input.filename === "string" ? row.input.filename : null,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}

async function startJob(deps: CoreDeps, actor: Actor, storeId: string, type: JobType, input: Record<string, unknown>, id = uuidv7()) {
  return deps.db.transaction(async (tx) => {
    const [row] = await tx.insert(jobsLog).values({ id, storeId, type, input, createdBy: actor.id ?? null }).returning();
    await enqueueEvent(tx, { storeId, type: "job.requested", payload: { jobId: id, jobType: type } });
    await writeAudit(tx, actor, { storeId, action: `job.${type}_started`, resourceType: "job", resourceId: id });
    return jobView(row!);
  });
}

export async function getJob(deps: CoreDeps, storeId: string, id: string) {
  const [row] = await deps.db.select().from(jobsLog).where(and(eq(jobsLog.storeId, storeId), eq(jobsLog.id, id)));
  if (!row) throw notFound("Job");
  return row;
}

export async function listJobs(deps: CoreDeps, storeId: string, type?: JobType) {
  const rows = await deps.db
    .select()
    .from(jobsLog)
    .where(and(eq(jobsLog.storeId, storeId), type ? eq(jobsLog.type, type) : undefined))
    .orderBy(desc(jobsLog.createdAt))
    .limit(50);
  return rows.map(jobView);
}

/** Error report as CSV (line, handle, message) for the admin download. */
export function jobErrorsCsv(row: JobRow): string {
  const esc = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return ["line,handle,message", ...row.errors.map((e) => [e.line ?? "", e.ref ?? "", e.message].map((v) => esc(String(v))).join(","))].join("\n") + "\n";
}

// ── Starting jobs ────────────────────────────────────────────────────────────
/** Stores the uploaded CSV in the active storage provider, then queues the import. */
export async function startProductImport(deps: CoreDeps, actor: Actor, storeId: string, file: { filename: string; data: Buffer }) {
  if (file.data.length === 0) throw new AppError("validation_failed", "The file is empty");
  const head = file.data.subarray(0, 2048).toString("utf8").replace(/^\uFEFF/, "");
  if (!/^"?Handle"?\s*,/i.test(head)) throw new AppError("validation_failed", "This is not a Shopify product CSV (the first column must be Handle)");
  const { provider, id: providerId } = await activeStorage(deps, storeId);
  const id = uuidv7();
  const key = `imports/${id}.csv`;
  await provider.put(key, file.data, { contentType: "text/csv" });
  return startJob(deps, actor, storeId, "product_import", { key, provider: providerId, filename: file.filename.slice(0, 200) }, id);
}

export async function startProductExport(deps: CoreDeps, actor: Actor, storeId: string, filter: Record<string, unknown> = {}) {
  const parsed = productListQuery.omit({ cursor: true, limit: true, sort: true }).parse(filter);
  return startJob(deps, actor, storeId, "product_export", { filter: parsed, filename: `products-${new Date().toISOString().slice(0, 10)}.csv` });
}

export async function startMediaMigration(deps: CoreDeps, actor: Actor, storeId: string, target: { provider: string; mode: "live" | "test" }) {
  const active = await getSetting(deps.db, storeId, "storage.active");
  if (active.provider === target.provider) throw new AppError("validation_failed", "Media already uses that provider");
  const [cred] = await deps.db
    .select({ id: providerCredentials.id, enabled: providerCredentials.enabled })
    .from(providerCredentials)
    .where(and(eq(providerCredentials.storeId, storeId), eq(providerCredentials.kind, "storage"), eq(providerCredentials.provider, target.provider), eq(providerCredentials.mode, target.mode)));
  if (!cred?.enabled) throw new AppError("validation_failed", "Save and enable that provider first");
  const running = await deps.db
    .select({ id: jobsLog.id })
    .from(jobsLog)
    .where(and(eq(jobsLog.storeId, storeId), eq(jobsLog.type, "media_migration"), sql`${jobsLog.status} in ('queued', 'running')`));
  if (running.length) throw new AppError("conflict", "A media migration is already running");
  return startJob(deps, actor, storeId, "media_migration", { provider: target.provider, mode: target.mode });
}

// ── Running jobs (worker) ────────────────────────────────────────────────────
class Progress {
  #last = 0;
  constructor(
    private deps: CoreDeps,
    private id: string,
  ) {}
  async update(values: Partial<Pick<JobRow, "processed" | "total" | "errorCount" | "errors" | "result">>, force = false) {
    if (!force && Date.now() - this.#last < 500) return;
    this.#last = Date.now();
    await this.deps.db.update(jobsLog).set(values).where(eq(jobsLog.id, this.id));
  }
}

export interface RunJobOptions {
  /** Lets CSV image URLs resolve to private addresses (tests only). */
  allowPrivateUrls?: boolean;
}

/** Runs a queued job to completion. Safe to re-run after a crash: every job is idempotent. */
export async function runJob(deps: CoreDeps, jobId: string, opts: RunJobOptions = {}) {
  const [row] = await deps.db.select().from(jobsLog).where(eq(jobsLog.id, jobId));
  if (!row) return { status: "skipped", reason: "job not found" };
  if (row.status === "completed" || row.status === "failed") return { status: "skipped", reason: `job already ${row.status}` };
  await deps.db.update(jobsLog).set({ status: "running", startedAt: row.startedAt ?? new Date() }).where(eq(jobsLog.id, jobId));
  const actor: Actor = { type: row.createdBy ? "staff" : "system", id: row.createdBy };
  const progress = new Progress(deps, jobId);
  try {
    let result: { result: Record<string, unknown>; errors: JobError[] };
    if (row.type === "product_import") result = await runImport(deps, actor, row, progress, opts);
    else if (row.type === "product_export") result = await runExport(deps, row, progress);
    else result = await runMigration(deps, actor, row, progress);
    const errors = result.errors.slice(0, MAX_ERRORS);
    await deps.db
      .update(jobsLog)
      .set({ status: "completed", result: result.result, errors, errorCount: result.errors.length, finishedAt: new Date() })
      .where(eq(jobsLog.id, jobId));
    return { status: "completed", errors: result.errors.length };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await deps.db
      .update(jobsLog)
      .set({ status: "failed", errors: [...row.errors, { message }].slice(0, MAX_ERRORS), errorCount: row.errorCount + 1, finishedAt: new Date() })
      .where(eq(jobsLog.id, jobId));
    return { status: "failed", error: message };
  }
}

async function storageFor(deps: CoreDeps, storeId: string, providerId: string): Promise<StorageProvider> {
  const p = await loadProvider(deps, { storeId, kind: "storage", provider: providerId, mode: "live" });
  if (!p) throw new Error(`Storage provider ${providerId} is not configured`);
  return p;
}

async function runImport(deps: CoreDeps, actor: Actor, row: JobRow, progress: Progress, opts: RunJobOptions) {
  const storage = await storageFor(deps, row.storeId, row.input.provider as string);
  const object = await storage.get(row.input.key as string);
  if (!object) throw new Error("The uploaded file is missing from storage");
  const store = await getStore(deps.db, row.storeId);
  const parsed = await parseShopifyCsv(await readAll(object.body), { currency: store.currency ?? "USD", weightUnit: store.weightUnit ?? "kg" });
  const errors: JobError[] = [...parsed.errors];
  let created = 0;
  let updated = 0;
  let imageErrors = 0;
  const total = parsed.products.length;
  await progress.update({ total, processed: 0, errorCount: errors.length }, true);
  for (const [i, product] of parsed.products.entries()) {
    try {
      const res = await importParsedProduct(deps, actor, row.storeId, product, { allowPrivateUrls: opts.allowPrivateUrls ?? false });
      if (res.created) created++;
      else updated++;
      for (const message of res.imageErrors) {
        imageErrors++;
        errors.push({ line: product.line, ref: product.handle, message: `Image skipped: ${message}` });
      }
    } catch (err) {
      errors.push({ line: product.line, ref: product.handle, message: describeError(err) });
    }
    await progress.update({ processed: i + 1, errorCount: errors.length, errors: errors.slice(0, MAX_ERRORS) }, i + 1 === total);
  }
  return { result: { created, updated, failed: total - created - updated, imageErrors, total }, errors };
}

function describeError(err: unknown): string {
  if (err instanceof AppError && Array.isArray(err.details)) {
    return (err.details as { path?: string; message: string }[]).map((d) => (d.path ? `${d.path}: ${d.message}` : d.message)).join("; ");
  }
  if (err && typeof err === "object" && "issues" in err && Array.isArray((err).issues)) {
    return (err as { issues: { path: PropertyKey[]; message: string }[] }).issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
  }
  return err instanceof Error ? err.message : String(err);
}

async function runExport(deps: CoreDeps, row: JobRow, progress: Progress) {
  const filter = productListQuery.omit({ cursor: true, limit: true, sort: true }).parse(row.input.filter ?? {});
  const out = await exportShopifyCsv(deps, row.storeId, filter, (done, total) => progress.update({ processed: done, total }));
  const { provider, id: providerId } = await activeStorage(deps, row.storeId);
  const key = `exports/${row.id}.csv`;
  await provider.put(key, out.csv, { contentType: "text/csv; charset=utf-8" });
  await progress.update({ processed: out.products, total: out.products }, true);
  return { result: { key, provider: providerId, products: out.products, rows: out.rows, bytes: out.csv.length }, errors: [] };
}

/** Reads a finished export for download. */
export async function readExport(deps: CoreDeps, storeId: string, jobId: string) {
  const row = await getJob(deps, storeId, jobId);
  if (row.type !== "product_export" || row.status !== "completed") throw new AppError("conflict", "The export is not ready yet");
  const storage = await storageFor(deps, storeId, row.result.provider as string);
  const object = await storage.get(row.result.key as string);
  if (!object) throw notFound("Export file");
  return { object, filename: (row.input.filename as string) ?? "products.csv" };
}

/**
 * Copies every media object (originals and renditions) to the target provider, repoints the rows,
 * then makes the target the active provider. Old objects are left in place (delete them yourself
 * once satisfied). Re-running skips rows already moved.
 */
async function runMigration(deps: CoreDeps, actor: Actor, row: JobRow, progress: Progress) {
  const targetId = row.input.provider as string;
  const target = await storageFor(deps, row.storeId, targetId);
  const rows = await deps.db.select().from(media).where(and(eq(media.storeId, row.storeId), ne(media.storageProvider, targetId), ne(media.status, "pending")));
  const sources = new Map<string, StorageProvider>();
  const errors: JobError[] = [];
  let moved = 0;
  await progress.update({ total: rows.length, processed: 0 }, true);
  for (const [i, m] of rows.entries()) {
    try {
      let source = sources.get(m.storageProvider);
      if (!source) {
        source = await storageFor(deps, row.storeId, m.storageProvider);
        sources.set(m.storageProvider, source);
      }
      for (const [key, contentType] of [[m.storageKey, m.contentType], ...m.renditions.map((r) => [r.key, `image/${r.format}`])] as [string, string][]) {
        const obj = await source.get(key);
        if (!obj) {
          if (key === m.storageKey) throw new Error(`${key} is missing on ${m.storageProvider}`);
          continue;
        }
        await target.put(key, obj.body, { contentType: obj.contentType ?? contentType, cacheControl: "public, max-age=31536000, immutable" });
      }
      await deps.db.update(media).set({ storageProvider: targetId }).where(eq(media.id, m.id));
      moved++;
    } catch (err) {
      errors.push({ ref: m.id, message: `${m.filename}: ${err instanceof Error ? err.message : String(err)}` });
    }
    await progress.update({ processed: i + 1, errorCount: errors.length }, i + 1 === rows.length);
  }
  if (errors.length === 0) {
    await deps.db.transaction(async (tx) => {
      await setSetting(tx, row.storeId, "storage.active", { provider: targetId, mode: row.input.mode === "test" ? "test" : "live" });
      await enqueueEvent(tx, { storeId: row.storeId, type: "store.updated" });
      await writeAudit(tx, actor, { storeId: row.storeId, action: "storage.migrated", resourceType: "setting", resourceId: "storage.active", metadata: { to: targetId, moved } });
    });
  }
  return { result: { moved, failed: errors.length, total: rows.length, activated: errors.length === 0 }, errors };
}
