import { randomBytes } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetDatabase } from "@shopkit/db/testing";
import { createDb } from "@shopkit/db";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { inject } from "vitest";
import { buildApp } from "../src/app.js";
import { loadConfig, type Config } from "../src/config.js";
import { buildDeps, type AppDeps } from "../src/deps.js";

export const silent = { info() {}, warn() {}, error() {} };

export interface Harness {
  app: FastifyInstance;
  deps: AppDeps;
  config: Config;
  env: Record<string, string>;
  reset(): Promise<void>;
  close(): Promise<void>;
}

export async function makeHarness(): Promise<Harness> {
  const env = {
    DATABASE_URL: inject("databaseUrl"),
    REDIS_URL: inject("redisUrl"),
    PUBLIC_URL: "https://shop.test",
    SESSION_SECRET: randomBytes(32).toString("hex"),
    SHOPKIT_MASTER_KEY: randomBytes(32).toString("base64"),
    SHOPKIT_DATA_DIR: await mkdtemp(join(tmpdir(), "shopkit-api-")),
    LOG_LEVEL: "silent",
  };
  const config = loadConfig(env);
  const deps = buildDeps(config, silent, env);
  const app = await buildApp(deps, config, { docsUi: false });
  await app.ready();
  const handle = createDb(env.DATABASE_URL, { max: 1 });
  return {
    app,
    deps,
    config,
    env,
    async reset() {
      await resetDatabase(handle);
      await deps.redis.flushdb();
    },
    async close() {
      await app.close();
      await deps.close();
      await handle.close();
    },
  };
}

/** Minimal cookie jar for app.inject. */
export class Jar {
  cookies = new Map<string, string>();
  absorb(res: LightMyRequestResponse) {
    for (const c of res.cookies) {
      if (c.value === "" || (c.expires && c.expires.getTime() < Date.now())) this.cookies.delete(c.name);
      else this.cookies.set(c.name, c.value);
    }
    return res;
  }
  get header() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

export const STRONG = "violet-Trombone-47-sunrise";
export const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");

export function multipart(field: string, filename: string, data: Buffer, type = "image/png") {
  const boundary = "----shopkit" + randomBytes(8).toString("hex");
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${filename}"\r\nContent-Type: ${type}\r\n\r\n`),
    data,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { payload: body, headers: { "content-type": `multipart/form-data; boundary=${boundary}` } };
}
