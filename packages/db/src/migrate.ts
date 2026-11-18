import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

export const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));

/** Applies forward-only migrations under a session advisory lock so concurrent runners serialise. */
export async function runMigrations(connectionString: string): Promise<void> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    await client.query("select pg_advisory_lock(727274)");
    await migrate(drizzle(client), { migrationsFolder });
  } finally {
    await client.query("select pg_advisory_unlock(727274)").catch(() => undefined);
    await client.end();
  }
}
