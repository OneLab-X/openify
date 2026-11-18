import { getSetupStatus, issueSetupToken, rotateKeys, verifyKeys } from "@shopkit/core";
import { runMigrations } from "@shopkit/db";
import { loadConfig } from "./config.js";
import { buildDeps } from "./deps.js";
import { createLogger } from "./logger.js";

/**
 * `pnpm shopkit <command>` (or `node dist/cli.js <command>` in the api container):
 *   db:migrate              apply forward-only migrations
 *   keys:verify             decrypt every stored secret with the loaded keyring
 *   keys:rotate --to <v>    re-wrap every DEK with master key version <v>
 *   setup:token             issue a new setup token while setup is still required
 */
const USAGE = "usage: shopkit <db:migrate | keys:verify | keys:rotate --to <version> | setup:token>";

export async function main(argv: string[], out: (line: string) => void = (l) => process.stdout.write(`${l}\n`)): Promise<number> {
  const [command, ...rest] = argv;
  if (command === "db:migrate") {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    await runMigrations(url);
    out("migrations applied");
    return 0;
  }
  if (!command || !["keys:verify", "keys:rotate", "setup:token"].includes(command)) {
    out(USAGE);
    return 2;
  }
  const config = loadConfig();
  const deps = buildDeps(config, createLogger({ LOG_LEVEL: "warn" }));
  try {
    if (command === "keys:verify") {
      const { checked, failed } = await verifyKeys(deps);
      out(`checked ${checked} secret(s), ${failed.length} failed`);
      for (const f of failed) out(`  FAILED ${f.table} ${f.id} (key version ${f.keyVersion})`);
      return failed.length ? 1 : 0;
    }
    if (command === "keys:rotate") {
      const idx = rest.indexOf("--to");
      const to = Number(rest[idx + 1]);
      if (idx === -1 || !Number.isInteger(to) || to < 1) {
        out(USAGE);
        return 2;
      }
      const result = await rotateKeys(deps, to);
      out(`re-wrapped ${result.credentials} credential(s) and ${result.totp} TOTP secret(s) to key version ${to}`);
      out(`set SHOPKIT_MASTER_KEY_VERSION=${to}, restart, run keys:verify, then remove old keys`);
      return 0;
    }
    const status = await getSetupStatus(deps);
    if (!status.required) {
      out("setup is already complete");
      return 1;
    }
    out(`setup token: ${await issueSetupToken(deps.redis)}`);
    return 0;
  } finally {
    await deps.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: unknown) => {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    },
  );
}
