import { randomBytes } from "node:crypto";
import {
  addCartLines,
  beginSetup,
  createPaymentSession,
  createProduct,
  enqueueEvent,
  getJob,
  getOrCreateCart,
  launchStore,
  saveOwnerStep,
  saveStorageStep,
  saveStoreStep,
  setSetting,
  startCheckout,
  startProductImport,
  updateCheckout,
  upsertCredential,
  uploadMedia,
} from "@shopkit/core";
import { analyticsDaily, and, checkouts, eq, inventoryItems, inventoryLevels, media as mediaTable, orders, outboxEvents, productVariants, sql, stores } from "@shopkit/db";
import type { ProviderDefinition } from "@shopkit/providers";
import { z } from "zod";
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

  it("releases unpaid reservations from the delayed inventory-release job and runs the abandoned-cart scan", async () => {
    const [store] = await rt.deps.db.select().from(stores);
    const storeId = store!.id;
    const fake: ProviderDefinition<"payment", Record<string, never>, Record<string, never>> = {
      id: "worker-fake",
      kind: "payment",
      displayName: "Fake",
      modes: ["test"],
      paymentFlow: "widget",
      configSchema: z.object({}),
      secretsSchema: z.object({}),
      create: () => ({
        testCredentials: () => Promise.resolve({ ok: true }),
        createSession: () => Promise.resolve({ providerOrderId: "fake_1", clientPayload: { provider: "worker-fake" } }),
        verifyReturn: () => Promise.reject(new Error("unused")),
        parseWebhook: () => Promise.reject(new Error("unused")),
        refund: () => Promise.reject(new Error("unused")),
        getPayment: () => Promise.reject(new Error("unused")),
      }),
    };
    if (!rt.deps.registry.get("payment", "worker-fake")) rt.deps.registry.register(fake);
    await upsertCredential(rt.deps, { type: "system" }, { storeId, kind: "payment", provider: "worker-fake", mode: "test" }, { config: {}, secrets: {} });
    await setSetting(rt.deps.db, storeId, "payments.mode", "test");
    const product = await createProduct(rt.deps, { type: "system" }, storeId, {
      title: "Reserved Tee",
      status: "active",
      variants: [{ options: [], price: 50_000, inventory: [{ available: 3 }] }],
    });
    const [variant] = await rt.deps.db.select().from(productVariants).where(eq(productVariants.productId, product.id));
    const { cart, token } = await getOrCreateCart(rt.deps, storeId, undefined);
    await addCartLines(rt.deps, storeId, cart, { lines: [{ variantId: variant!.id, quantity: 2 }] });
    const checkout = await startCheckout(rt.deps, storeId, cart);
    await updateCheckout(rt.deps, storeId, checkout, cart, {
      email: "late@pls.test",
      shippingAddress: { line1: "1 Road", city: "Pune", country: "IN" },
      paymentProvider: "worker-fake",
    });
    const session = await createPaymentSession(rt.deps, storeId, checkout.id, token);
    const stock = async () => {
      const [l] = await rt.deps.db
        .select({ available: inventoryLevels.available, committed: inventoryLevels.committed })
        .from(inventoryLevels)
        .innerJoin(inventoryItems, eq(inventoryItems.id, inventoryLevels.inventoryItemId))
        .where(eq(inventoryItems.variantId, variant!.id));
      return l;
    };
    expect(await stock()).toEqual({ available: 1, committed: 2 });

    // Pretend the reservation timeout has passed so the delayed job is due now.
    const past = new Date(Date.now() - 1000);
    await rt.deps.db.update(orders).set({ reservationExpiresAt: past }).where(eq(orders.id, session.orderId));
    await rt.deps.db.execute(sql`update outbox_events set payload = jsonb_set(payload, '{dueAt}', to_jsonb(${past.toISOString()}::text)) where type = 'order.reservation_created'`);
    while ((await rt.dispatchOnce()) > 0);
    const release = rt.queues.get("inventory-release")!;
    for (let i = 0; i < 50 && (await release.getJobCountByTypes("completed")) < 1; i++) await new Promise((r) => setTimeout(r, 200));
    expect(await stock()).toEqual({ available: 3, committed: 0 });

    // The scan finds the checkout once its configured delay has passed.
    await setSetting(rt.deps.db, storeId, "notifications.config", { abandonedCheckoutEnabled: true, abandonedCheckoutDelayMinutes: 1, merchantEmails: [], alertNewOrder: true, alertPaidOrder: true });
    await rt.deps.db.execute(sql`update checkouts set updated_at = now() - interval '2 minutes' where id = ${checkout.id}`);
    await rt.deps.db.execute(sql`update carts set updated_at = now() - interval '2 minutes' where id = ${cart.id}`);
    await rt.scheduleRecurring();
    const scan = rt.queues.get("abandoned-cart")!;
    await scan.add("scan-now", {});
    for (let i = 0; i < 50 && (await scan.getJobCountByTypes("completed")) < 1; i++) await new Promise((r) => setTimeout(r, 200));
    const [co] = await rt.deps.db.select().from(checkouts).where(eq(checkouts.id, checkout.id));
    expect(co!.abandonedNotifiedAt).not.toBeNull();
    expect((await rt.deps.db.select().from(outboxEvents)).some((e) => e.type === "checkout.abandoned")).toBe(true);
  }, 60_000);

  it("rolls up analytics_daily for the funnel from the repeatable analytics job", async () => {
    const [store] = await rt.deps.db.select().from(stores);
    await rt.scheduleRecurring();
    const q = rt.queues.get("analytics")!;
    expect((await q.getJobSchedulers()).map((s) => s.key)).toContain("rollup");
    const job = await q.add("rollup", {});
    for (let i = 0; i < 50 && !(await job.isCompleted()); i++) await new Promise((r) => setTimeout(r, 200));
    const today = new Date().toISOString().slice(0, 10);
    const [row] = await rt.deps.db.select().from(analyticsDaily).where(and(eq(analyticsDaily.storeId, store!.id), eq(analyticsDaily.day, today)));
    // The earlier test in this file added a cart line and started a checkout today.
    expect(row).toMatchObject({ addToCarts: expect.any(Number), checkoutsStarted: expect.any(Number) });
    expect(row!.addToCarts).toBeGreaterThan(0);
    expect(row!.checkoutsStarted).toBeGreaterThan(0);
  }, 30_000);
});
