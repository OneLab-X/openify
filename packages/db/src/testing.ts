import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { sql } from "drizzle-orm";
import { createDb, type DbHandle } from "./client.js";
import { runMigrations } from "./migrate.js";

export interface TestDatabase extends DbHandle {
  url: string;
  container: StartedPostgreSqlContainer;
  /** Empties every table (fast reset between tests). */
  reset(): Promise<void>;
  stop(): Promise<void>;
}

export async function startTestDatabase(): Promise<TestDatabase> {
  const container = await new PostgreSqlContainer("postgres:17-alpine").start();
  const url = container.getConnectionUri();
  await runMigrations(url);
  const handle = createDb(url, { max: 5 });
  return {
    ...handle,
    url,
    container,
    reset: () => resetDatabase(handle),
    async stop() {
      await handle.close();
      await container.stop();
    },
  };
}

export async function resetDatabase({ db }: Pick<DbHandle, "db">): Promise<void> {
  const rows = await db.execute<{ tablename: string }>(
    sql`select tablename from pg_tables where schemaname = 'public'`,
  );
  const names = rows.rows.map((r) => `"${r.tablename}"`).join(", ");
  if (names) await db.execute(sql.raw(`truncate ${names} restart identity cascade`));
}
