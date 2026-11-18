import { createDb, outboxEvents, stores } from "@shopkit/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { inject } from "vitest";
import { dispatchOutbox, enqueueEvent, type OutboxEvent } from "../src/outbox.js";
import { makeDeps, type TestDeps } from "./harness.js";

let deps: TestDeps;
let storeId: string;
beforeAll(async () => {
  deps = await makeDeps();
});
afterAll(() => deps.close());
beforeEach(async () => {
  await deps.reset();
  storeId = (await deps.db.insert(stores).values({ name: "Shop" }).returning())[0]!.id;
});

describe("outbox", () => {
  it("events written in a rolled-back transaction never dispatch", async () => {
    await deps.db.transaction(async (tx) => {
      await enqueueEvent(tx, { storeId, type: "media.created", payload: { mediaId: "x" } });
      tx.rollback();
    }).catch(() => undefined);
    expect(await deps.db.$count(outboxEvents)).toBe(0);
  });

  it("dispatches in order and marks events", async () => {
    await enqueueEvent(deps.db, { storeId, type: "store.launched" });
    await enqueueEvent(deps.db, { storeId, type: "media.created", payload: { mediaId: "m" } });
    const seen: OutboxEvent[] = [];
    expect(await dispatchOutbox(deps.db, async (e) => void seen.push(...e))).toEqual({ dispatched: 2, failed: 0 });
    expect(seen.map((e) => e.type)).toEqual(["store.launched", "media.created"]);
    expect(await dispatchOutbox(deps.db, async () => undefined)).toEqual({ dispatched: 0, failed: 0 });
    const rows = await deps.db.select().from(outboxEvents);
    expect(rows.every((r) => r.dispatchedAt && r.attempts === 1)).toBe(true);
  });

  it("reschedules with backoff when publishing fails", async () => {
    await enqueueEvent(deps.db, { storeId, type: "store.launched" });
    expect(await dispatchOutbox(deps.db, () => Promise.reject(new Error("redis down")))).toEqual({ dispatched: 0, failed: 1 });
    const [row] = await deps.db.select().from(outboxEvents);
    expect(row).toMatchObject({ dispatchedAt: null, attempts: 1, lastError: "redis down" });
    expect(row!.availableAt.getTime()).toBeGreaterThan(Date.now());
    expect(await dispatchOutbox(deps.db, async () => undefined)).toEqual({ dispatched: 0, failed: 0 });
  });

  it("concurrent dispatchers never claim the same event (FOR UPDATE SKIP LOCKED)", async () => {
    for (let i = 0; i < 40; i++) await enqueueEvent(deps.db, { storeId, type: "media.created", payload: { i } });
    const other = createDb(inject("databaseUrl"), { max: 2 });
    const claimed: string[][] = [[], []];
    const slowPublish = (bucket: string[]) => async (events: OutboxEvent[]) => {
      bucket.push(...events.map((e) => e.id));
      await new Promise((r) => setTimeout(r, 200));
    };
    await Promise.all([
      dispatchOutbox(deps.db, slowPublish(claimed[0]!), 25),
      new Promise((r) => setTimeout(r, 50)).then(() => dispatchOutbox(other.db, slowPublish(claimed[1]!), 25)),
    ]);
    await other.close();
    const all = [...claimed[0]!, ...claimed[1]!];
    expect(claimed[0]).toHaveLength(25);
    expect(claimed[1]).toHaveLength(15);
    expect(new Set(all).size).toBe(40);
  });
});
