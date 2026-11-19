import { z } from "zod";

/** Process configuration. Merchant/provider secrets are never read from env (SPEC §6). */
const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().default(4000),
  HOST: z.string().default("0.0.0.0"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  PUBLIC_URL: z.url().transform((u) => u.replace(/\/$/, "")),
  SESSION_SECRET: z.string().min(32, "SESSION_SECRET must be at least 32 characters"),
  REVALIDATE_SECRET: z.string().min(16).optional(),
  SHOPKIT_DATA_DIR: z.string().default("./data"),
  /** Optional Meilisearch (compose profile `meilisearch`); Postgres full-text is used without it. */
  MEILISEARCH_URL: z.preprocess((v) => (v === "" ? undefined : v), z.url().optional()),
  MEILISEARCH_API_KEY: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),
  TRUST_PROXY: z
    .string()
    .default("true")
    .transform((v) => v === "true"),
});
export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid configuration:\n${lines}`);
  }
  return parsed.data;
}

export const secureCookies = (config: Config) => config.PUBLIC_URL.startsWith("https://");
