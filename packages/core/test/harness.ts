import { randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadKeyring } from "@shopkit/crypto";
import { createDb } from "@shopkit/db";
import { resetDatabase } from "@shopkit/db/testing";
import { createDefaultRegistry, type EmailMessage, type ProviderDefinition } from "@shopkit/providers";
import { Redis } from "ioredis";
import { inject } from "vitest";
import { z } from "zod";
import type { CoreDeps } from "../src/deps.js";

export const sentEmails: EmailMessage[] = [];

/** In-memory email provider for tests. `fail: true` in config makes sends throw. */
export const memoryEmail: ProviderDefinition<"email", { fromEmail: string; fail?: boolean }, { apiKey?: string }> = {
  id: "memory",
  kind: "email",
  displayName: "Memory",
  modes: ["live", "test"],
  configSchema: z.object({ fromEmail: z.email(), fail: z.boolean().optional() }),
  secretsSchema: z.object({ apiKey: z.string().optional() }),
  last4Field: "apiKey",
  create: (ctx) => ({
    testCredentials: () => Promise.resolve(ctx.config.fail ? { ok: false, error: "nope" } : { ok: true }),
    send: (msg) => {
      if (ctx.config.fail) return Promise.reject(new Error("send failed"));
      sentEmails.push(msg);
      return Promise.resolve({ id: `mem-${sentEmails.length}` });
    },
  }),
};

export const silentLogger = { info() {}, warn() {}, error() {} };
export const masterKey = () => randomBytes(32).toString("base64");

export interface TestDeps extends CoreDeps {
  reset(): Promise<void>;
  close(): Promise<void>;
}

export async function makeDeps(env: Record<string, string> = { SHOPKIT_MASTER_KEY: masterKey() }): Promise<TestDeps> {
  const handle = createDb(inject("databaseUrl"), { max: 5 });
  const redis = new Redis(inject("redisUrl"));
  const registry = createDefaultRegistry().register(memoryEmail);
  const dataDir = await mkdtemp(join(tmpdir(), "shopkit-core-"));
  return {
    db: handle.db,
    redis,
    keyring: loadKeyring(env),
    registry,
    runtime: { publicUrl: "https://shop.test", dataDir, signingSecret: "test-signing-secret" },
    logger: silentLogger,
    async reset() {
      await resetDatabase(handle);
      await redis.flushdb();
      sentEmails.length = 0;
    },
    async close() {
      redis.disconnect();
      await handle.close();
    },
  };
}

export const ACTOR = { type: "staff" as const, ip: "127.0.0.1", userAgent: "vitest" };
export const STRONG_PASSWORD = "correct horse battery staple 42";
