import { resolve } from "node:path";
import {
  deleteStoredObjects,
  deliverEmail,
  dispatchOutbox,
  emailJob,
  getInstallStore,
  meiliSearch,
  releaseExpiredReservation,
  scanAbandonedCheckouts,
  sweepExpiredReservations,
  processMedia,
  routeOutboxEvent,
  runJob,
  type CoreDeps,
  type Logger,
  type OutboxEvent,
  type QueueName,
} from "@shopkit/core";
import { loadKeyring } from "@shopkit/crypto";
import { createDb } from "@shopkit/db";
import { createDefaultRegistry } from "@shopkit/providers";
import { Queue, Worker, type Job, type JobsOptions } from "bullmq";
import { Redis } from "ioredis";
import type { WorkerConfig } from "./config.js";

/** Retry policy for every job (SPEC §13): exponential backoff, kept in the failed set (dead letter) after 8 tries. */
export const JOB_OPTIONS: JobsOptions = {
  attempts: 8,
  backoff: { type: "exponential", delay: 5_000 },
  removeOnComplete: { age: 7 * 24 * 3600, count: 5_000 },
  removeOnFail: false,
};

export interface WorkerRuntime {
  deps: CoreDeps;
  queues: Map<QueueName, Queue>;
  workers: Worker[];
  /** One dispatcher pass; returns how many events were published. */
  dispatchOnce(): Promise<number>;
  /** Registers repeatable jobs (abandoned-checkout scan + reservation sweep). */
  scheduleRecurring(): Promise<void>;
  close(): Promise<void>;
}

export function createRuntime(config: WorkerConfig, logger: Logger, env: Record<string, string | undefined> = process.env): WorkerRuntime {
  const db = createDb(config.DATABASE_URL);
  const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 3 });
  // BullMQ workers need blocking connections without a retry cap.
  const connection = () => new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });
  const deps: CoreDeps = {
    db: db.db,
    redis,
    keyring: loadKeyring(env),
    registry: createDefaultRegistry(),
    runtime: { publicUrl: config.PUBLIC_URL, dataDir: resolve(config.SHOPKIT_DATA_DIR), signingSecret: config.SESSION_SECRET },
    logger,
    ...(config.MEILISEARCH_URL ? { search: meiliSearch(db.db, { url: config.MEILISEARCH_URL, apiKey: config.MEILISEARCH_API_KEY }) } : {}),
  };

  const queueConn = connection();
  const queues = new Map<QueueName, Queue>();
  const queue = (name: QueueName) => {
    let q = queues.get(name);
    if (!q) {
      q = new Queue(name, { connection: queueConn, prefix: "sk", defaultJobOptions: JOB_OPTIONS });
      queues.set(name, q);
    }
    return q;
  };

  async function publish(events: OutboxEvent[]) {
    for (const event of events) {
      for (const job of await routeOutboxEvent(deps, event)) {
        await queue(job.queue).add(job.name, job.data, { jobId: job.jobId, ...(job.delay ? { delay: job.delay } : {}) });
      }
    }
  }

  const processors: Partial<Record<QueueName, (job: Job) => Promise<unknown>>> = {
    email: async (job) => {
      const result = await deliverEmail(deps, emailJob.parse(job.data));
      logger.info({ jobId: job.id, status: result.status, reason: result.reason }, "email job");
      return result;
    },
    revalidate: async (job) => {
      const { tags } = job.data as { tags: string[] };
      if (!config.STOREFRONT_INTERNAL_URL || !config.REVALIDATE_SECRET) return { status: "skipped", reason: "storefront revalidation not configured" };
      const res = await fetch(`${config.STOREFRONT_INTERNAL_URL}/internal/revalidate`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-revalidate-secret": config.REVALIDATE_SECRET },
        body: JSON.stringify({ tags }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`storefront revalidate failed (${res.status})`);
      return { status: "revalidated", tags };
    },
    images: async (job) => {
      const data = job.data as { storeId: string; mediaId?: string; provider?: string; keys?: string[] };
      if (job.name === "delete") return deleteStoredObjects(deps, data.storeId, data.provider!, data.keys ?? []);
      const result = await processMedia(deps, data.mediaId!);
      logger.info({ jobId: job.id, mediaId: data.mediaId, ...result }, "image job");
      return result;
    },
    "search-index": async (job) => {
      if (!deps.search) return { status: "skipped", reason: "postgres search needs no index" };
      const { storeId, productIds } = job.data as { storeId: string; productIds: string[] };
      await deps.search.sync(storeId, productIds);
      return { status: "indexed", count: productIds.length };
    },
    imports: async (job) => {
      const result = await runJob(deps, (job.data as { jobId: string }).jobId, { allowPrivateUrls: config.IMPORT_ALLOW_PRIVATE_URLS });
      logger.info({ jobId: job.id, ...result }, "import/export job");
      return result;
    },
    "media-migration": async (job) => runJob(deps, (job.data as { jobId: string }).jobId),
    // Delayed job per unpaid order (SPEC §13 inventory-release): frees stock after the timeout.
    "inventory-release": async (job) => {
      const { storeId, orderId } = job.data as { storeId: string; orderId: string };
      const released = await releaseExpiredReservation(deps, storeId, orderId);
      return { status: released ? "released" : "kept" };
    },
    // Repeatable scan: abandoned-checkout reminders, plus a sweep for reservations whose delayed job was lost.
    "abandoned-cart": async () => {
      const store = await getInstallStore(deps.db);
      const reminders = store?.status === "active" ? await scanAbandonedCheckouts(deps, store.id) : 0;
      const released = await sweepExpiredReservations(deps);
      if (reminders || released) logger.info({ reminders, released }, "abandoned-cart scan");
      return { reminders, released };
    },
  };
  const concurrency: Partial<Record<QueueName, number>> = { images: config.IMAGE_CONCURRENCY, imports: 1, "media-migration": 1 };

  const workers = (Object.entries(processors) as [QueueName, (job: Job) => Promise<unknown>][]).map(([name, fn]) => {
    const w = new Worker(name, fn, {
      connection: connection(),
      prefix: "sk",
      concurrency: concurrency[name] ?? config.WORKER_CONCURRENCY,
      // CSV imports and migrations can run for minutes; keep the lock renewed generously.
      ...(name === "imports" || name === "media-migration" ? { lockDuration: 120_000 } : {}),
    });
    w.on("failed", (job, err) =>
      logger.warn({ queue: name, jobId: job?.id, attempts: job?.attemptsMade, err: err.message }, "job failed"),
    );
    return w;
  });

  return {
    deps,
    queues,
    workers,
    async dispatchOnce() {
      return (await dispatchOutbox(deps.db, publish)).dispatched;
    },
    async scheduleRecurring() {
      await queue("abandoned-cart").upsertJobScheduler("scan", { every: config.ABANDONED_SCAN_INTERVAL_MS }, { name: "scan", data: {} });
    },
    async close() {
      await Promise.all(workers.map((w) => w.close()));
      await Promise.all([...queues.values()].map((q) => q.close()));
      queueConn.disconnect();
      redis.disconnect();
      await db.close();
    },
  };
}
