import { createServer } from "node:http";
import { pino } from "pino";
import { loadWorkerConfig } from "./config.js";
import { createRuntime } from "./runtime.js";

const config = loadWorkerConfig();
const logger = pino({
  level: config.LOG_LEVEL,
  redact: { paths: ["*.password", "*.secret", "*.secrets", "*.apiKey", "*.token", "*.keySecret"], censor: "[redacted]" },
});
const rt = createRuntime(config, logger);

let healthy = true;
let stopping = false;
async function loop() {
  while (!stopping) {
    try {
      // Drain while there is work, then wait for the next tick.
      while (!stopping && (await rt.dispatchOnce()) > 0);
      healthy = true;
    } catch (err) {
      healthy = false;
      logger.error({ err }, "outbox dispatch failed");
    }
    await new Promise((r) => setTimeout(r, config.OUTBOX_INTERVAL_MS));
  }
}
const running = loop();

const health = createServer((req, res) => {
  res.writeHead(healthy ? 200 : 503, { "content-type": "application/json" }).end(JSON.stringify({ ok: healthy }));
}).listen(config.HEALTH_PORT);
logger.info({ port: config.HEALTH_PORT }, "worker started");

async function shutdown(signal: string) {
  logger.info({ signal }, "worker shutting down");
  stopping = true;
  await running;
  health.close();
  await rt.close();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
