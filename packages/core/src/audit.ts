import { auditLogs, and, desc, eq, lt, or, type Executor } from "@shopkit/db";
import type { Actor } from "./deps.js";

export interface AuditEntry {
  storeId: string;
  action: string;
  resourceType?: string;
  resourceId?: string;
  metadata?: Record<string, unknown>;
}

/** Writes an audit row. Never put secret values in metadata, only field names. */
export async function writeAudit(db: Executor, actor: Actor, entry: AuditEntry): Promise<void> {
  await db.insert(auditLogs).values({
    storeId: entry.storeId,
    actorType: actor.type,
    actorId: actor.id ?? null,
    action: entry.action,
    resourceType: entry.resourceType ?? null,
    resourceId: entry.resourceId ?? null,
    ip: actor.ip ?? null,
    userAgent: actor.userAgent?.slice(0, 500) ?? null,
    metadata: entry.metadata ?? {},
  });
}

/** Cursor pagination over (created_at desc, id desc). The cursor is the last row's id. */
export async function listAudit(db: Executor, storeId: string, opts: { limit: number; cursor?: string }) {
  let where = eq(auditLogs.storeId, storeId);
  if (opts.cursor) {
    const [anchor] = await db.select().from(auditLogs).where(and(eq(auditLogs.storeId, storeId), eq(auditLogs.id, opts.cursor)));
    if (anchor) {
      where = and(
        where,
        or(
          lt(auditLogs.createdAt, anchor.createdAt),
          and(eq(auditLogs.createdAt, anchor.createdAt), lt(auditLogs.id, anchor.id)),
        ),
      )!;
    }
  }
  const rows = await db
    .select()
    .from(auditLogs)
    .where(where)
    .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
    .limit(opts.limit + 1);
  const page = rows.slice(0, opts.limit);
  return { items: page, nextCursor: rows.length > opts.limit ? (page.at(-1)?.id ?? null) : null };
}
