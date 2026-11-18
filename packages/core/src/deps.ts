import type { Keyring } from "@shopkit/crypto";
import type { Db } from "@shopkit/db";
import type { ProviderRegistry, ProviderRuntime } from "@shopkit/providers";
import type { Redis } from "ioredis";

export interface Logger {
  info(obj: object | string, msg?: string): void;
  warn(obj: object | string, msg?: string): void;
  error(obj: object | string, msg?: string): void;
}

/** Everything core services need. Built once per process by apps/api and apps/worker. */
export interface CoreDeps {
  db: Db;
  redis: Redis;
  keyring: Keyring;
  registry: ProviderRegistry;
  runtime: ProviderRuntime;
  logger: Logger;
  now?: () => Date;
}

/** Who performed an action, for audit logs. */
export interface Actor {
  type: "staff" | "setup" | "system" | "api_key";
  id?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

export const now = (deps: Pick<CoreDeps, "now">) => (deps.now ? deps.now() : new Date());
export const SYSTEM: Actor = { type: "system" };
