import { loadKeyring } from "@shopkit/crypto";
import { auditLogs, eq, providerCredentials, sql, stores } from "@shopkit/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  deleteCredential, listCredentials, loadProvider, rotateKeys, testCredential, upsertCredential, verifyKeys, clearSecretCache,
} from "../src/credentials.js";
import { AppError } from "../src/errors.js";
import { ACTOR, makeDeps, masterKey, type TestDeps } from "./harness.js";

let deps: TestDeps;
let storeId: string;
beforeAll(async () => {
  deps = await makeDeps();
});
afterAll(() => deps.close());
beforeEach(async () => {
  await deps.reset();
  clearSecretCache();
  storeId = (await deps.db.insert(stores).values({ name: "Shop" }).returning())[0]!.id;
});

const SECRET = "rzp_secret_TOPSECRET_9876";
const rzp = () => ({ storeId, kind: "payment" as const, provider: "razorpay", mode: "test" as const });

describe("credentials", () => {
  it("stores secrets encrypted; the row and API summary never contain plaintext", async () => {
    const summary = await upsertCredential(deps, ACTOR, rzp(), {
      config: { keyId: "rzp_test_abc" }, secrets: { keySecret: SECRET, webhookSecret: "whsec_ABCDEFGH" },
    });
    expect(summary).toMatchObject({ configured: true, last4: "9876", config: { keyId: "rzp_test_abc" } });
    expect(summary.secretFields.sort()).toEqual(["keySecret", "webhookSecret"]);
    expect(JSON.stringify(summary)).not.toContain("TOPSECRET");

    const { rows } = await deps.db.execute<Record<string, unknown>>(sql`select * from provider_credentials`);
    const dump = JSON.stringify(rows, (_k, v: unknown) => (Buffer.isBuffer(v) ? v.toString("latin1") : v));
    expect(dump).not.toContain("TOPSECRET");
    expect(dump).not.toContain("whsec_ABCDEFGH");
    const ct = await deps.db.execute<{ c: string }>(sql`select encode(ciphertext, 'escape') as c from provider_credentials`);
    expect(ct.rows[0]!.c).not.toContain("TOPSECRET");

    const audits = await deps.db.select().from(auditLogs);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ action: "credential.created", metadata: { secretFieldsChanged: ["keySecret", "webhookSecret"] } });
    expect(JSON.stringify(audits)).not.toContain("TOPSECRET");
  });

  it("keeps saved secrets when fields are left empty, and replaces them when given", async () => {
    await upsertCredential(deps, ACTOR, rzp(), { config: { keyId: "rzp_test_abc" }, secrets: { keySecret: SECRET } });
    await upsertCredential(deps, ACTOR, rzp(), { config: { keyId: "rzp_test_xyz" }, secrets: { keySecret: "" } });
    const p = await loadProvider(deps, rzp());
    expect(p).not.toBeNull();
    const [row] = await deps.db.select().from(providerCredentials);
    expect(row!.config).toEqual({ keyId: "rzp_test_xyz" });
    expect(row!.last4).toBe("9876");
    const s = await upsertCredential(deps, ACTOR, rzp(), { config: { keyId: "rzp_test_xyz" }, secrets: { keySecret: "another-secret-1234" } });
    expect(s.last4).toBe("1234");
    expect((await deps.db.select().from(auditLogs)).map((a) => a.action)).toEqual(["credential.created", "credential.updated", "credential.updated"]);
  });

  it("validates with the provider's zod schemas", async () => {
    const err = await upsertCredential(deps, ACTOR, rzp(), { config: { keyId: "bad" }, secrets: { keySecret: SECRET } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).details).toEqual([expect.objectContaining({ path: "config.keyId" })]);
    await expect(upsertCredential(deps, ACTOR, rzp(), { config: { keyId: "rzp_test_a" }, secrets: {} })).rejects.toMatchObject({
      details: [expect.objectContaining({ path: "secrets.keySecret" })],
    });
    await expect(upsertCredential(deps, ACTOR, { ...rzp(), provider: "stripe" }, {})).rejects.toMatchObject({ code: "not_found" });
    await expect(upsertCredential(deps, ACTOR, { ...rzp(), provider: "cod" }, {})).rejects.toThrow(/does not support test mode/);
  });

  it("lists, disables and deletes", async () => {
    await upsertCredential(deps, ACTOR, rzp(), { config: { keyId: "rzp_test_a" }, secrets: { keySecret: SECRET } });
    await upsertCredential(deps, ACTOR, { storeId, kind: "payment", provider: "cod", mode: "live" }, { enabled: false });
    expect((await listCredentials(deps, storeId, "payment")).map((c) => c.provider).sort()).toEqual(["cod", "razorpay"]);
    expect(await loadProvider(deps, { storeId, kind: "payment", provider: "cod", mode: "live" })).toBeNull();
    expect(await loadProvider(deps, { storeId, kind: "payment", provider: "nope", mode: "live" })).toBeNull();
    await deleteCredential(deps, ACTOR, rzp());
    await expect(deleteCredential(deps, ACTOR, rzp())).rejects.toMatchObject({ code: "not_found" });
    expect(await listCredentials(deps, storeId)).toHaveLength(1);
  });

  it("tests drafts without saving them", async () => {
    const ok = await testCredential(deps, { storeId, kind: "storage", provider: "local", mode: "live" }, { config: {} });
    expect(ok).toEqual({ ok: true });
    const bad = await testCredential(deps, rzp(), { config: { keyId: "nope" } });
    expect(bad).toMatchObject({ ok: false, error: expect.stringMatching(/config.keyId/) });
    expect(await deps.db.$count(providerCredentials)).toBe(0);
  });

  it("rotates keys and verifies every row; detects tampering", async () => {
    const k1 = masterKey();
    const k2 = masterKey();
    const ring = loadKeyring({ SHOPKIT_MASTER_KEY_1: k1, SHOPKIT_MASTER_KEY_2: k2, SHOPKIT_MASTER_KEY_VERSION: "1" });
    const d = { ...deps, keyring: ring };
    await upsertCredential(d, ACTOR, rzp(), { config: { keyId: "rzp_test_a" }, secrets: { keySecret: SECRET } });
    await expect(rotateKeys(d, 3)).rejects.toThrow(/not loaded/);
    expect(await rotateKeys(d, 2)).toEqual({ credentials: 1, totp: 0 });
    expect(await rotateKeys(d, 2)).toEqual({ credentials: 0, totp: 0 });
    const [row] = await deps.db.select().from(providerCredentials);
    expect(row!.keyVersion).toBe(2);
    expect(row!.rotatedAt).not.toBeNull();

    const onlyV2 = { ...deps, keyring: loadKeyring({ SHOPKIT_MASTER_KEY_2: k2, SHOPKIT_MASTER_KEY_VERSION: "2" }) };
    expect(await verifyKeys(onlyV2)).toEqual({ checked: 1, failed: [] });
    const wrong = { ...deps, keyring: loadKeyring({ SHOPKIT_MASTER_KEY_2: masterKey(), SHOPKIT_MASTER_KEY_VERSION: "2" }) };
    expect((await verifyKeys(wrong)).failed).toHaveLength(1);

    const flipped = Buffer.from(row!.ciphertext);
    flipped[0] = flipped[0]! ^ 1;
    await deps.db.update(providerCredentials).set({ ciphertext: flipped }).where(eq(providerCredentials.id, row!.id));
    expect((await verifyKeys(onlyV2)).failed).toEqual([{ table: "provider_credentials", id: row!.id, keyVersion: 2 }]);
  });
});
