import { z } from "zod";

const envSchema = z.object({
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  PUBLIC_URL: z.url().transform((u) => u.replace(/\/$/, "")),
  SESSION_SECRET: z.string().min(32),
  SHOPKIT_DATA_DIR: z.string().default("./data"),
  HEALTH_PORT: z.coerce.number().int().default(4100),
  OUTBOX_INTERVAL_MS: z.coerce.number().int().min(100).default(1000),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).default(5),
  STOREFRONT_INTERNAL_URL: z.url().optional(),
  REVALIDATE_SECRET: z.string().min(16).optional(),
  MEILISEARCH_URL: z.preprocess((v) => (v === "" ? undefined : v), z.url().optional()),
  MEILISEARCH_API_KEY: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),
  /** Test stacks only: lets CSV image URLs point at private addresses (SSRF guard off). */
  IMPORT_ALLOW_PRIVATE_URLS: z
    .string()
    .default("false")
    .transform((v) => v === "true"),
  IMAGE_CONCURRENCY: z.coerce.number().int().min(1).default(2),
  /** How often the abandoned-checkout scan runs; the reminder delay itself is a store setting. */
  ABANDONED_SCAN_INTERVAL_MS: z.coerce.number().int().min(1000).default(60_000),
  ANALYTICS_ROLLUP_INTERVAL_MS: z.coerce.number().int().min(1000).default(15 * 60_000),
});
export type WorkerConfig = z.infer<typeof envSchema>;

export function loadWorkerConfig(env: Record<string, string | undefined> = process.env): WorkerConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid configuration:\n${parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n")}`);
  }
  return parsed.data;
}
