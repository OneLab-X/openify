import {
  buildAad,
  decryptSecret,
  encryptSecret,
  last4 as last4Of,
  rewrapSecret,
  type EncryptedSecret,
} from "@shopkit/crypto";
import { and, eq, providerCredentials, staffUsers, isNotNull, type Executor } from "@shopkit/db";
import type { ProviderInstances, ProviderKind, ProviderMode, TestResult } from "@shopkit/providers";
import { z } from "zod";
import { writeAudit } from "./audit.js";
import type { Actor, CoreDeps } from "./deps.js";
import { AppError } from "./errors.js";
import { openJson, sealJson, totpAad } from "./secrets.js";

export const credentialInput = z.object({
  config: z.record(z.string(), z.unknown()).default({}),
  /** Write-only. Empty or missing fields keep the saved value. */
  secrets: z.record(z.string(), z.unknown()).default({}),
  enabled: z.boolean().default(true),
});
export type CredentialInput = z.input<typeof credentialInput>;

export interface CredentialSummary {
  id: string;
  kind: ProviderKind;
  provider: string;
  mode: ProviderMode;
  enabled: boolean;
  config: Record<string, unknown>;
  configured: true;
  last4: string | null;
  /** Names (never values) of secret fields that hold a value. */
  secretFields: string[];
  updatedAt: string;
}

type Row = typeof providerCredentials.$inferSelect;

const aadFor = (r: Pick<Row, "storeId" | "kind" | "provider" | "mode">) =>
  buildAad({ storeId: r.storeId, kind: r.kind, provider: r.provider, mode: r.mode });

const recordOf = (r: Row): EncryptedSecret => ({
  ciphertext: r.ciphertext,
  iv: r.iv,
  authTag: r.authTag,
  wrappedDek: r.wrappedDek,
  dekIv: r.dekIv,
  dekTag: r.dekTag,
  keyVersion: r.keyVersion,
});

// Decrypted secrets live in process memory for at most 5 minutes (SPEC §6), keyed by row version.
const CACHE_MS = 5 * 60 * 1000;
const cache = new Map<string, { at: number; value: Record<string, unknown> }>();

function decryptRow(deps: Pick<CoreDeps, "keyring">, row: Row): Record<string, unknown> {
  const cacheKey = `${row.id}:${row.updatedAt.getTime()}:${row.keyVersion}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = decryptSecret<Record<string, unknown>>(recordOf(row), aadFor(row), deps.keyring);
  cache.set(cacheKey, { at: Date.now(), value });
  return value;
}

export function clearSecretCache(): void {
  cache.clear();
}
setInterval(() => {
  const cutoff = Date.now() - CACHE_MS;
  for (const [k, v] of cache) if (v.at < cutoff) cache.delete(k);
}, 60_000).unref();

function summarize(row: Row, secrets: Record<string, unknown>): CredentialSummary {
  return {
    id: row.id,
    kind: row.kind,
    provider: row.provider,
    mode: row.mode,
    enabled: row.enabled,
    config: row.config,
    configured: true,
    last4: row.last4,
    secretFields: Object.entries(secrets)
      .filter(([, v]) => v !== undefined && v !== null && v !== "")
      .map(([k]) => k),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function cleanSecrets(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined && v !== null && v !== ""));
}

function zodDetails(err: z.ZodError, prefix: "config" | "secrets") {
  return err.issues.map((i) => ({ path: [prefix, ...i.path].join("."), message: i.message }));
}

async function findRow(db: Executor, storeId: string, kind: ProviderKind, provider: string, mode: ProviderMode) {
  const [row] = await db
    .select()
    .from(providerCredentials)
    .where(
      and(
        eq(providerCredentials.storeId, storeId),
        eq(providerCredentials.kind, kind),
        eq(providerCredentials.provider, provider),
        eq(providerCredentials.mode, mode),
      ),
    );
  return row;
}

interface Target {
  storeId: string;
  kind: ProviderKind;
  provider: string;
  mode: ProviderMode;
}

/** Validates config + merged secrets against the provider's zod schemas. */
async function resolveDraft(deps: CoreDeps, db: Executor, target: Target, input: CredentialInput) {
  const def = deps.registry.get(target.kind, target.provider);
  if (!def) throw new AppError("not_found", `Unknown ${target.kind} provider "${target.provider}"`);
  if (!def.modes.includes(target.mode)) {
    throw new AppError("validation_failed", `${def.displayName} does not support ${target.mode} mode`);
  }
  const parsed = credentialInput.parse(input);
  const existing = await findRow(db, target.storeId, target.kind, target.provider, target.mode);
  const saved = existing ? decryptRow(deps, existing) : {};
  const config = def.configSchema.safeParse(parsed.config);
  if (!config.success) {
    throw new AppError("validation_failed", "Check the highlighted fields", zodDetails(config.error, "config"));
  }
  const secrets = def.secretsSchema.safeParse({ ...saved, ...cleanSecrets(parsed.secrets) });
  if (!secrets.success) {
    throw new AppError("validation_failed", "Check the highlighted fields", zodDetails(secrets.error, "secrets"));
  }
  return {
    def,
    existing,
    enabled: parsed.enabled,
    config: config.data as Record<string, unknown>,
    secrets: secrets.data as Record<string, unknown>,
    changedSecretFields: Object.keys(cleanSecrets(parsed.secrets)),
  };
}

export async function upsertCredential(
  deps: CoreDeps,
  actor: Actor,
  target: Target,
  input: CredentialInput,
  db: Executor = deps.db,
): Promise<CredentialSummary> {
  const draft = await resolveDraft(deps, db, target, input);
  const sealed = encryptSecret(draft.secrets, aadFor(target), deps.keyring);
  const lastField = draft.def.last4Field;
  const values = {
    ...target,
    config: draft.config,
    ...sealed,
    last4: lastField ? last4Of(draft.secrets[lastField] as string | undefined) : null,
    enabled: draft.enabled,
  };
  const write = async (tx: Executor) => {
    const [row] = await tx
      .insert(providerCredentials)
      .values(values)
      .onConflictDoUpdate({
        target: [providerCredentials.storeId, providerCredentials.kind, providerCredentials.provider, providerCredentials.mode],
        set: { ...values, updatedAt: new Date() },
      })
      .returning();
    await writeAudit(tx, actor, {
      storeId: target.storeId,
      action: draft.existing ? "credential.updated" : "credential.created",
      resourceType: "provider_credential",
      resourceId: row!.id,
      metadata: {
        kind: target.kind,
        provider: target.provider,
        mode: target.mode,
        enabled: draft.enabled,
        configKeys: Object.keys(draft.config),
        secretFieldsChanged: draft.changedSecretFields,
      },
    });
    return row!;
  };
  const row = "transaction" in db ? await db.transaction(write) : await write(db);
  return summarize(row, draft.secrets);
}

export async function deleteCredential(deps: CoreDeps, actor: Actor, target: Target): Promise<void> {
  await deps.db.transaction(async (tx) => {
    const row = await findRow(tx, target.storeId, target.kind, target.provider, target.mode);
    if (!row) throw new AppError("not_found", "Credential not found");
    await tx.delete(providerCredentials).where(eq(providerCredentials.id, row.id));
    await writeAudit(tx, actor, {
      storeId: target.storeId,
      action: "credential.deleted",
      resourceType: "provider_credential",
      resourceId: row.id,
      metadata: { kind: target.kind, provider: target.provider, mode: target.mode },
    });
  });
}

export async function listCredentials(deps: CoreDeps, storeId: string, kind?: ProviderKind): Promise<CredentialSummary[]> {
  const rows = await deps.db
    .select()
    .from(providerCredentials)
    .where(and(eq(providerCredentials.storeId, storeId), kind ? eq(providerCredentials.kind, kind) : undefined));
  return rows.map((r) => summarize(r, decryptRow(deps, r)));
}

const TEST_TIMEOUT_MS = 20_000;

/** "Test connection": runs the adapter's read-only check against a draft (unsaved fields fall back to saved ones). */
export async function testCredential(deps: CoreDeps, target: Target, input: CredentialInput): Promise<TestResult> {
  let draft;
  try {
    draft = await resolveDraft(deps, deps.db, target, input);
  } catch (err) {
    if (err instanceof AppError && err.code === "validation_failed") {
      return { ok: false, error: err.message + formatDetails(err.details) };
    }
    throw err;
  }
  const instance = draft.def.create({
    storeId: target.storeId,
    mode: target.mode,
    config: draft.config,
    secrets: draft.secrets,
    runtime: deps.runtime,
  });
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<TestResult>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, error: "Connection test timed out" }), TEST_TIMEOUT_MS);
  });
  try {
    return await Promise.race([instance.testCredentials(), timeout]);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Connection test failed" };
  } finally {
    clearTimeout(timer);
  }
}

function formatDetails(details: unknown): string {
  if (!Array.isArray(details) || details.length === 0) return "";
  return `: ${(details as { path: string; message: string }[]).map((d) => `${d.path} ${d.message}`).join("; ")}`;
}

/** Builds a live adapter instance from saved (encrypted) credentials. Decryption stays in memory. */
export async function loadProvider<K extends ProviderKind>(
  deps: CoreDeps,
  target: { storeId: string; kind: K; provider: string; mode: ProviderMode },
): Promise<ProviderInstances[K] | null> {
  const def = deps.registry.get(target.kind, target.provider);
  if (!def) return null;
  const row = await findRow(deps.db, target.storeId, target.kind, target.provider, target.mode);
  if (!row || !row.enabled) return null;
  return def.create({
    storeId: target.storeId,
    mode: target.mode,
    config: row.config,
    secrets: decryptRow(deps, row),
    runtime: deps.runtime,
  });
}

/** Re-wraps every DEK (credentials and staff TOTP secrets) under `toVersion`. */
export async function rotateKeys(deps: CoreDeps, toVersion: number): Promise<{ credentials: number; totp: number }> {
  if (!deps.keyring.keys.has(toVersion)) throw new AppError("bad_request", `Master key version ${toVersion} is not loaded`);
  return deps.db.transaction(async (tx) => {
    let credentials = 0;
    let totp = 0;
    for (const row of await tx.select().from(providerCredentials).for("update")) {
      if (row.keyVersion === toVersion) continue;
      const moved = rewrapSecret(recordOf(row), aadFor(row), deps.keyring, toVersion);
      await tx
        .update(providerCredentials)
        .set({ wrappedDek: moved.wrappedDek, dekIv: moved.dekIv, dekTag: moved.dekTag, keyVersion: moved.keyVersion, rotatedAt: new Date() })
        .where(eq(providerCredentials.id, row.id));
      credentials++;
    }
    for (const staff of await tx.select().from(staffUsers).where(isNotNull(staffUsers.totpSecret)).for("update")) {
      if (staff.totpSecret!.keyVersion === toVersion) continue;
      const aad = totpAad(staff.storeId, staff.id);
      const value = openJson<unknown>(staff.totpSecret!, aad, deps.keyring);
      const ring = { current: toVersion, keys: deps.keyring.keys };
      await tx.update(staffUsers).set({ totpSecret: sealJson(value, aad, ring) }).where(eq(staffUsers.id, staff.id));
      totp++;
    }
    clearSecretCache();
    return { credentials, totp };
  });
}

/** Decrypts every stored secret to prove the loaded keyring can read them. */
export async function verifyKeys(deps: CoreDeps): Promise<{ checked: number; failed: { table: string; id: string; keyVersion: number }[] }> {
  const failed: { table: string; id: string; keyVersion: number }[] = [];
  let checked = 0;
  for (const row of await deps.db.select().from(providerCredentials)) {
    checked++;
    try {
      decryptSecret(recordOf(row), aadFor(row), deps.keyring);
    } catch {
      failed.push({ table: "provider_credentials", id: row.id, keyVersion: row.keyVersion });
    }
  }
  for (const staff of await deps.db.select().from(staffUsers).where(isNotNull(staffUsers.totpSecret))) {
    checked++;
    try {
      openJson(staff.totpSecret!, totpAad(staff.storeId, staff.id), deps.keyring);
    } catch {
      failed.push({ table: "staff_users.totp_secret", id: staff.id, keyVersion: staff.totpSecret!.keyVersion });
    }
  }
  return { checked, failed };
}
