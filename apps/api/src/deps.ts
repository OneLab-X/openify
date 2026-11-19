import { resolve } from "node:path";
import { meiliSearch, type CoreDeps, type Logger } from "@shopkit/core";
import { loadKeyring } from "@shopkit/crypto";
import { createDb } from "@shopkit/db";
import { createDefaultRegistry } from "@shopkit/providers";
import { Redis } from "ioredis";
import type { Config } from "./config.js";

export interface AppDeps extends CoreDeps {
  close(): Promise<void>;
}

export function buildDeps(config: Config, logger: Logger, env: Record<string, string | undefined> = process.env): AppDeps {
  const keyring = loadKeyring(env);
  const handle = createDb(config.DATABASE_URL);
  const redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 3 });
  return {
    db: handle.db,
    redis,
    keyring,
    registry: createDefaultRegistry(),
    runtime: {
      publicUrl: config.PUBLIC_URL,
      dataDir: resolve(config.SHOPKIT_DATA_DIR),
      signingSecret: config.SESSION_SECRET,
    },
    logger,
    ...(config.MEILISEARCH_URL ? { search: meiliSearch(handle.db, { url: config.MEILISEARCH_URL, apiKey: config.MEILISEARCH_API_KEY }) } : {}),
    async close() {
      redis.disconnect();
      await handle.close();
    },
  };
}
