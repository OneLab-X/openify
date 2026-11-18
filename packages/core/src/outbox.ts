import { outboxEvents, sql, type Db, type Executor } from "@shopkit/db";

export const OUTBOX_EVENT_TYPES = ["store.launched", "media.created", "email.requested"] as const;
export type OutboxEventType = (typeof OUTBOX_EVENT_TYPES)[number];

export interface OutboxEvent {
  id: string;
  storeId: string;
  type: string;
  payload: Record<string, unknown>;
  attempts: number;
  createdAt: Date;
}

/** Records a side effect in the caller's transaction. Never send/queue directly after a write. */
export async function enqueueEvent(
  tx: Executor,
  event: { storeId: string; type: OutboxEventType; payload?: Record<string, unknown> },
): Promise<string> {
  const [row] = await tx
    .insert(outboxEvents)
    .values({ storeId: event.storeId, type: event.type, payload: event.payload ?? {} })
    .returning({ id: outboxEvents.id });
  return row!.id;
}

/**
 * Claims up to `limit` due events with FOR UPDATE SKIP LOCKED (so N dispatchers never share an
 * event), hands them to `publish`, and marks them dispatched in the same transaction. If publish
 * fails the batch is rescheduled with exponential backoff.
 */
export async function dispatchOutbox(
  db: Db,
  publish: (events: OutboxEvent[]) => Promise<void>,
  limit = 100,
): Promise<{ dispatched: number; failed: number }> {
  return db.transaction(async (tx) => {
    const { rows } = await tx.execute<{
      id: string;
      store_id: string;
      type: string;
      payload: Record<string, unknown>;
      attempts: number;
      created_at: Date;
    }>(sql`
      select id, store_id, type, payload, attempts, created_at
      from ${outboxEvents}
      where dispatched_at is null and available_at <= now()
      order by created_at, id
      limit ${limit}
      for update skip locked`);
    if (rows.length === 0) return { dispatched: 0, failed: 0 };
    const events: OutboxEvent[] = rows.map((r) => ({
      id: r.id,
      storeId: r.store_id,
      type: r.type,
      payload: r.payload,
      attempts: r.attempts,
      createdAt: r.created_at,
    }));
    const ids = sql.join(events.map((e) => sql`${e.id}::uuid`), sql`, `);
    try {
      await publish(events);
      await tx.execute(sql`update ${outboxEvents} set dispatched_at = now(), attempts = attempts + 1 where id in (${ids})`);
      return { dispatched: events.length, failed: 0 };
    } catch (err) {
      const message = (err instanceof Error ? err.message : String(err)).slice(0, 1000);
      await tx.execute(sql`
        update ${outboxEvents}
        set attempts = attempts + 1, last_error = ${message},
            available_at = now() + least(power(2, attempts + 1), 3600) * interval '1 second'
        where id in (${ids})`);
      return { dispatched: 0, failed: events.length };
    }
  });
}
