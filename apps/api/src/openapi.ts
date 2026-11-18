import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildApp } from "./app.js";
import type { Config } from "./config.js";
import type { AppDeps } from "./deps.js";

/** Emits the OpenAPI document without connecting to Postgres/Redis (routes are only registered). */
export async function emitOpenApi(): Promise<string> {
  const config: Config = {
    NODE_ENV: "test",
    PORT: 0,
    HOST: "127.0.0.1",
    LOG_LEVEL: "silent",
    DATABASE_URL: "postgres://unused",
    REDIS_URL: "redis://unused",
    PUBLIC_URL: "http://localhost",
    SESSION_SECRET: "x".repeat(32),
    SHOPKIT_DATA_DIR: "./data",
    TRUST_PROXY: true,
  };
  const { createDefaultRegistry } = await import("@shopkit/providers");
  const deps = { registry: createDefaultRegistry(), redis: { defineCommand() {} } } as unknown as AppDeps;
  const app = await buildApp(deps, config, { docsUi: false });
  await app.ready();
  const doc = JSON.stringify(app.swagger(), null, 2) + "\n";
  await app.close();
  return doc;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = resolve(process.argv[2] ?? "openapi.json");
  await writeFile(out, await emitOpenApi());
  process.stdout.write(`wrote ${out}\n`);
}
