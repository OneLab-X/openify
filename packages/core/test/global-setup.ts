import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { RedisContainer } from "@testcontainers/redis";
import { runMigrations } from "@shopkit/db";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    databaseUrl: string;
    redisUrl: string;
  }
}

export default async function setup(project: TestProject) {
  const [pg, redis] = await Promise.all([
    new PostgreSqlContainer("postgres:17-alpine").start(),
    new RedisContainer("redis:7-alpine").start(),
  ]);
  await runMigrations(pg.getConnectionUri());
  project.provide("databaseUrl", pg.getConnectionUri());
  project.provide("redisUrl", redis.getConnectionUrl());
  return async () => {
    await Promise.all([pg.stop(), redis.stop()]);
  };
}
