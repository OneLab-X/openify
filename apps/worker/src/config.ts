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
});
export type WorkerConfig = z.infer<typeof envSchema>;

export function loadWorkerConfig(env: Record<string, string | undefined> = process.env): WorkerConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new Error(`Invalid configuration:\n${parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n")}`);
  }
  return parsed.data;
}
