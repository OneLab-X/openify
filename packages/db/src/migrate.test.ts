import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { runMigrations } from "./migrate.js";
import { providerCredentials, stores } from "./schema/index.js";
import { startTestDatabase, type TestDatabase } from "./testing.js";

let t: TestDatabase;
beforeAll(async () => {
  t = await startTestDatabase();
});
afterAll(async () => {
  await t?.stop();
});

const PHASE1_TABLES = [
  "stores", "settings", "setup_state", "domains", "staff_users", "roles", "role_permissions",
  "api_keys", "audit_logs", "provider_credentials", "outbox_events", "media", "locations",
];

describe("migrations", () => {
  it("creates every phase-1 table and the required extensions", async () => {
    const tables = await t.db.execute<{ tablename: string }>(
      sql`select tablename from pg_tables where schemaname = 'public'`,
    );
    const names = tables.rows.map((r) => r.tablename);
    for (const name of PHASE1_TABLES) expect(names).toContain(name);
    const ext = await t.db.execute<{ extname: string }>(sql`select extname from pg_extension`);
    expect(ext.rows.map((r) => r.extname)).toEqual(expect.arrayContaining(["citext", "pg_trgm"]));
  });

  it("puts a non-null store_id on every tenant table", async () => {
    const rows = await t.db.execute<{ table_name: string; is_nullable: string }>(sql`
      select t.table_name, c.is_nullable
      from information_schema.tables t
      left join information_schema.columns c
        on c.table_name = t.table_name and c.column_name = 'store_id' and c.table_schema = 'public'
      where t.table_schema = 'public' and t.table_name not in ('stores')
        and t.table_name not like '\_\_%'`);
    for (const row of rows.rows) expect(row, row.table_name).toMatchObject({ is_nullable: "NO" });
  });

  it("is idempotent", async () => {
    await expect(runMigrations(t.url)).resolves.toBeUndefined();
  });

  it("enforces one credential per store/kind/provider/mode", async () => {
    const [store] = await t.db.insert(stores).values({ name: "Test" }).returning();
    const row = {
      storeId: store!.id, kind: "payment" as const, provider: "razorpay", mode: "test" as const,
      ciphertext: Buffer.from([1]), iv: Buffer.from([1]), authTag: Buffer.from([1]),
      wrappedDek: Buffer.from([1]), dekIv: Buffer.from([1]), dekTag: Buffer.from([1]), keyVersion: 1,
    };
    await t.db.insert(providerCredentials).values(row);
    await expect(t.db.insert(providerCredentials).values(row)).rejects.toThrow();
    const [saved] = await t.db.select().from(providerCredentials);
    expect(Buffer.isBuffer(saved!.ciphertext)).toBe(true);
    expect(saved!.id[14]).toBe("7");
  });

  it("reset empties tables", async () => {
    await t.reset();
    expect(await t.db.$count(stores)).toBe(0);
  });
});
