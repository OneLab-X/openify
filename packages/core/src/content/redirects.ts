import { and, asc, eq, ilike, redirects, sql, type Executor } from "@shopkit/db";
import { z } from "zod";
import { writeAudit } from "../audit.js";
import type { Actor, CoreDeps } from "../deps.js";
import { AppError, notFound } from "../errors.js";
import { enqueueEvent } from "../outbox.js";

/**
 * URL redirects (SPEC §11). Paths are stored lower-cased without query or trailing slash. When a
 * handle changes, the old URL redirects to the new one automatically and existing redirects that
 * pointed at the old URL are re-pointed, so there are never chains.
 */
export function normalizePath(input: string): string {
  let p = input.trim();
  try {
    if (/^https?:\/\//i.test(p)) p = new URL(p).pathname;
  } catch {
    /* keep as typed */
  }
  p = p.split(/[?#]/)[0] ?? "";
  if (!p.startsWith("/")) p = `/${p}`;
  p = p.replace(/\/{2,}/g, "/");
  if (p.length > 1) p = p.replace(/\/+$/, "");
  try {
    p = decodeURI(p);
  } catch {
    /* already decoded */
  }
  return p.toLowerCase();
}

const target = z
  .string()
  .trim()
  .min(1)
  .max(2000)
  .refine((v) => v.startsWith("/") ? !v.startsWith("//") : /^https?:\/\//i.test(v) && URL.canParse(v), "Use a path like /collections/sale or a full https:// link");

export const redirectInput = z.object({ fromPath: z.string().trim().min(2).max(1000), toPath: target });

export async function listRedirects(db: Executor, storeId: string, q: { query?: string; limit?: number; offset?: number } = {}) {
  const where = and(eq(redirects.storeId, storeId), q.query ? ilike(redirects.fromPath, `%${q.query.toLowerCase().replace(/[\\%_]/g, "\\$&")}%`) : undefined);
  const [rows, [count]] = await Promise.all([
    db.select().from(redirects).where(where).orderBy(asc(redirects.fromPath)).limit(Math.min(q.limit ?? 100, 500)).offset(q.offset ?? 0),
    db.select({ n: sql<number>`count(*)::int` }).from(redirects).where(where),
  ]);
  return { items: rows.map(redirectView), total: count?.n ?? 0 };
}

const redirectView = (r: typeof redirects.$inferSelect) => ({ id: r.id, fromPath: r.fromPath, toPath: r.toPath, automatic: r.automatic, createdAt: r.createdAt.toISOString() });

export async function saveRedirect(deps: CoreDeps, actor: Actor, storeId: string, input: z.input<typeof redirectInput>, id?: string) {
  const d = redirectInput.parse(input);
  const from = normalizePath(d.fromPath);
  const to = d.toPath;
  if (from === "/") throw new AppError("validation_failed", "The home page cannot be redirected");
  if (to.startsWith("/") && normalizePath(to) === from) throw new AppError("validation_failed", "A redirect cannot point to itself");
  return deps.db.transaction(async (tx) => {
    const [clash] = await tx.select({ id: redirects.id }).from(redirects).where(and(eq(redirects.storeId, storeId), eq(redirects.fromPath, from)));
    if (clash && clash.id !== id) throw new AppError("conflict", `${from} already redirects somewhere`);
    const [row] = id
      ? await tx.update(redirects).set({ fromPath: from, toPath: to, automatic: false }).where(and(eq(redirects.storeId, storeId), eq(redirects.id, id))).returning()
      : await tx.insert(redirects).values({ storeId, fromPath: from, toPath: to }).returning();
    if (!row) throw notFound("Redirect");
    await enqueueEvent(tx, { storeId, type: "redirect.updated", payload: { fromPath: from } });
    await writeAudit(tx, actor, { storeId, action: id ? "redirect.updated" : "redirect.created", resourceType: "redirect", resourceId: row.id, metadata: { from, to } });
    return redirectView(row);
  });
}

export async function deleteRedirect(deps: CoreDeps, actor: Actor, storeId: string, id: string) {
  await deps.db.transaction(async (tx) => {
    const [row] = await tx.delete(redirects).where(and(eq(redirects.storeId, storeId), eq(redirects.id, id))).returning();
    if (!row) throw notFound("Redirect");
    await enqueueEvent(tx, { storeId, type: "redirect.updated", payload: { fromPath: row.fromPath } });
    await writeAudit(tx, actor, { storeId, action: "redirect.deleted", resourceType: "redirect", resourceId: id });
  });
}

/** Called in the transaction that renamed a handle: old → new, and nothing ever chains. */
export async function recordHandleChange(tx: Executor, storeId: string, oldPath: string, newPath: string) {
  const from = normalizePath(oldPath);
  const to = normalizePath(newPath);
  if (from === to) return;
  // The new URL is live again: a redirect away from it would hide the page.
  await tx.delete(redirects).where(and(eq(redirects.storeId, storeId), eq(redirects.fromPath, to)));
  await tx.update(redirects).set({ toPath: to }).where(and(eq(redirects.storeId, storeId), eq(redirects.toPath, from)));
  await tx
    .insert(redirects)
    .values({ storeId, fromPath: from, toPath: to, automatic: true })
    .onConflictDoUpdate({ target: [redirects.storeId, redirects.fromPath], set: { toPath: to, automatic: true } });
}

/** Storefront lookup for a path that matched nothing. */
export async function findRedirect(db: Executor, storeId: string, path: string): Promise<string | null> {
  const [row] = await db.select({ toPath: redirects.toPath }).from(redirects).where(and(eq(redirects.storeId, storeId), eq(redirects.fromPath, normalizePath(path))));
  return row?.toPath ?? null;
}
