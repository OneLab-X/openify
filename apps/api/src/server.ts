import { getSetupStatus, issueSetupToken } from "@shopkit/core";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { buildDeps } from "./deps.js";
import { createLogger } from "./logger.js";

const config = loadConfig();
const logger = createLogger(config);
const deps = buildDeps(config, logger);
const app = await buildApp(deps, config, { logger });

const status = await getSetupStatus(deps);
if (status.required) {
  const token = await issueSetupToken(deps.redis);
  // Written to stdout directly (not through pino) so log redaction never hides it from the operator.
  const url = `${config.PUBLIC_URL}/admin/setup`;
  process.stdout.write(`\n  Shopkit setup token: ${token}\n  Open ${url} and paste the token to start setup.\n\n`);
}

const shutdown = async (signal: string) => {
  app.log.info({ signal }, "shutting down");
  await app.close();
  await deps.close();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ port: config.PORT, host: config.HOST });
