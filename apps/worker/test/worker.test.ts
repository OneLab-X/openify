import { randomBytes } from "node:crypto";
import { beginSetup, enqueueEvent, getJob, launchStore, saveOwnerStep, saveStorageStep, saveStoreStep, startProductImport, uploadMedia } from "@shopkit/core";
import { eq, media as mediaTable, outboxEvents, stores } from "@shopkit/db";
import sharp from "sharp";
import { resetDatabase } from "@shopkit/db/testing";
import { QueueEvents } from "bullmq";
import { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { loadWorkerConfig } from "../src/config.js";
import { createRuntime, type WorkerRuntime } from "../src/runtime.js";

const silent = { info() {}, warn() {}, error() {} };
let rt: WorkerRuntime;

beforeAll(async () => {
  const env = {
    DATABASE_URL: inject("databaseUrl"),
    REDIS_URL: inject("redisUrl"),
    PUBLIC_URL: "https://shop.test",
    SESSION_SECRET: "s".repeat(32),
    SHOPKIT_MASTER_KEY: randomBytes(32).toString("base64"),
    SHOPKIT_DATA_DIR: "/tmp/shopkit-worker-test",
  };
  rt = createRuntime(loadWorkerConfig(env), silent, env);
  await resetDatabase(rt.deps);
  await rt.deps.redis.flushdb();
});
afterAll(() => rt.close());

describe("worker", () => {
  it("dispatches outbox events to queues and processes them idempotently", async () => {
    const actor = { type: "setup" as const };
    const storeId = await beginSetup(rt.deps);
    await saveOwnerStep(rt.deps, actor, { name: "Asha", email: "asha@pls.test", password: "violet-Trombone-47-sunrise" });
    await saveStorageStep(rt.deps, actor, { provider: "local", mode: "live" });
    await saveStoreStep(rt.deps, actor, {
      name: "PLS", email: "hello@pls.test", country: "IN", currency: "INR", timezone: "UTC", locale: "en-IN", weightUnit: "kg", publicUrl: "https://shop.test",
    });
    await launchStore(rt.deps, actor);
    await enqueueEvent(rt.deps.db, { storeId, type: "media.created", payload: { mediaId: "m1" } });

    const conn = new Redis(inject("redisUrl"), { maxRetriesPerRequest: null });
    const emailEvents = new QueueEvents("email", { connection: conn, prefix: "sk" });
    await emailEvents.waitUntilReady();
    const done = new Promise<string>((resolve) => emailEvents.on("completed", ({ returnvalue }) => resolve(JSON.stringify(returnvalue))));

    expect(await rt.dispatchOnce()).toBe(2);
    expect(await rt.dispatchOnce()).toBe(0);
    expect(await done).toContain("no email provider");

    // Re-publishing the same event id does not create a second job.
    const [launched] = (await rt.deps.db.select().from(outboxEvents)).filter((e) => e.type === "store.launched");
    await rt.queues.get("email")!.add("store-launched", {}, { jobId: `${launched!.id}-email` });
    expect(await rt.queues.get("email")!.getJobCountByTypes("completed", "waiting", "active")).toBe(1);

    const images = rt.queues.get("images")!;
    await new Promise((r) => setTimeout(r, 500));
    expect(await images.getJobCountByTypes("completed")).toBe(1);
    await emailEvents.close();
    conn.disconnect();
  });

  it("runs catalog jobs: image renditions, CSV import, search sync and revalidation", async () => {
    const [store] = await rt.deps.db.select({ id: stores.id }).from(stores);
    const storeId = store!.id;
    const image = await sharp({ create: { width: 400, height: 300, channels: 3, background: "#16a085" } }).png().toBuffer();
    const media = await uploadMedia(rt.deps, { type: "system" }, storeId, { filename: "a.png", data: image });
    const csv = "Handle,Title,Option1 Name,Option1 Value,Variant Price,Status\nworker-kurta,Worker Kurta,Size,S,10.00,active\n";
    const job = await startProductImport(rt.deps, { type: "system" }, storeId, { filename: "w.csv", data: Buffer.from(csv) });

    const conn = new Redis(inject("redisUrl"), { maxRetriesPerRequest: null });
    const waitFor = async (queue: string, count: number) => {
      const q = rt.queues.get(queue as never)!;
      for (let i = 0; i < 100; i++) {
        if ((await q.getJobCountByTypes("completed")) >= count) return;
        await new Promise((r) => setTimeout(r, 200));
      }
      throw new Error(`${queue} did not complete ${count} job(s)`);
    };
    while ((await rt.dispatchOnce()) > 0);
    await waitFor("images", 2); // the stub media from the first test + this upload
    await waitFor("imports", 1);
    expect((await getJob(rt.deps, storeId, job.id)).result).toMatchObject({ created: 1 });
    const [row] = await rt.deps.db.select().from(mediaTable).where(eq(mediaTable.id, media.id));
    expect(row!.renditions.length).toBeGreaterThan(0);

    // The import's product.created and the image's media.processed events fan out next.
    while ((await rt.dispatchOnce()) > 0);
    await waitFor("search-index", 1);
    const revalidate = rt.queues.get("revalidate")!;
    const jobs = await revalidate.getJobs(["completed", "waiting", "active", "failed"]);
    const tags = jobs.flatMap((j) => (j.data as { tags: string[] }).tags);
    expect(tags).toEqual(expect.arrayContaining(["products", "product-handle:worker-kurta", "collections"]));
    conn.disconnect();
  }, 60_000);
});
