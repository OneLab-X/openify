import { pino, type Logger } from "pino";
import type { Config } from "./config.js";

/** pino redaction (SPEC §10): never log credentials, cookies or secret-looking fields. */
export const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  'req.headers["x-setup-token"]',
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
  "*.password",
  "*.secret",
  "*.secrets",
  "*.key",
  "*.apiKey",
  "*.token",
  "*.keySecret",
  "*.webhookSecret",
  "*.secretAccessKey",
];

export function createLogger(config: Pick<Config, "LOG_LEVEL">, destination?: NodeJS.WritableStream): Logger {
  return pino(
    { level: config.LOG_LEVEL, redact: { paths: REDACT_PATHS, censor: "[redacted]" } },
    destination as Parameters<typeof pino>[1],
  );
}
