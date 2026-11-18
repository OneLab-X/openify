import { randomToken, sha256Hex } from "@shopkit/crypto";
import { and, eq, rolePermissions, roles, staffUsers, type Executor } from "@shopkit/db";
import { z } from "zod";
import { writeAudit } from "../audit.js";
import type { Actor, CoreDeps } from "../deps.js";
import { now } from "../deps.js";
import { AppError, unauthorized } from "../errors.js";
import { openJson, sealJson, totpAad } from "../secrets.js";
import { getStore } from "../stores.js";
import { assertStrongPassword, hashPassword, verifyDummy, verifyPassword } from "./password.js";
import { SYSTEM_ROLES, type SystemRole } from "./permissions.js";
import { createSession, destroyAllSessions } from "./sessions.js";
import { generateTotpSecret, otpauthUrl, verifyTotp } from "./totp.js";

export const LOCKOUT_THRESHOLD = 5;
export const LOCKOUT_MINUTES = 15;

export const loginInput = z.object({ email: z.email().max(254), password: z.string().min(1).max(256) });
export const totpCodeInput = z.object({ code: z.string().regex(/^\d{6}$/, "Enter the 6-digit code") });

type StaffRow = typeof staffUsers.$inferSelect;

/** Creates owner/admin/staff roles for a store if missing. */
export async function ensureSystemRoles(db: Executor, storeId: string): Promise<Record<SystemRole, string>> {
  const ids = {} as Record<SystemRole, string>;
  for (const [key, def] of Object.entries(SYSTEM_ROLES) as [SystemRole, (typeof SYSTEM_ROLES)[SystemRole]][]) {
    const [existing] = await db.select().from(roles).where(and(eq(roles.storeId, storeId), eq(roles.key, key)));
    if (existing) {
      ids[key] = existing.id;
      continue;
    }
    const [role] = await db.insert(roles).values({ storeId, key, name: def.name, isSystem: true }).returning();
    await db.insert(rolePermissions).values(def.permissions.map((permission) => ({ storeId, roleId: role!.id, permission })));
    ids[key] = role!.id;
  }
  return ids;
}

export async function permissionsFor(db: Executor, roleId: string): Promise<string[]> {
  const rows = await db.select({ p: rolePermissions.permission }).from(rolePermissions).where(eq(rolePermissions.roleId, roleId));
  return rows.map((r) => r.p);
}

export async function staffView(db: Executor, staff: StaffRow) {
  const [role] = await db.select().from(roles).where(eq(roles.id, staff.roleId));
  return {
    id: staff.id,
    name: staff.name,
    email: staff.email,
    role: role?.key ?? "staff",
    roleName: role?.name ?? "Staff",
    permissions: await permissionsFor(db, staff.roleId),
    totpEnabled: staff.totpEnabled,
    lastLoginAt: staff.lastLoginAt?.toISOString() ?? null,
  };
}
export type StaffView = Awaited<ReturnType<typeof staffView>>;

export async function getStaff(db: Executor, storeId: string, staffId: string): Promise<StaffRow | null> {
  const [row] = await db.select().from(staffUsers).where(and(eq(staffUsers.storeId, storeId), eq(staffUsers.id, staffId)));
  return row ?? null;
}

export type LoginResult =
  | { status: "ok"; token: string; csrf: string; staff: StaffView }
  | { status: "totp_required"; challenge: string };

const challengeKey = (c: string) => `sk:totp-challenge:${sha256Hex(c)}`;

async function recordFailure(deps: CoreDeps, staff: StaffRow, actor: Actor, reason: string): Promise<never> {
  const failures = staff.failedLoginCount + 1;
  const lock = failures >= LOCKOUT_THRESHOLD;
  await deps.db
    .update(staffUsers)
    .set({
      failedLoginCount: lock ? 0 : failures,
      lockedUntil: lock ? new Date(now(deps).getTime() + LOCKOUT_MINUTES * 60_000) : staff.lockedUntil,
    })
    .where(eq(staffUsers.id, staff.id));
  await writeAudit(deps.db, { ...actor, type: "staff", id: staff.id }, {
    storeId: staff.storeId,
    action: lock ? "staff.locked" : "staff.login_failed",
    resourceType: "staff_user",
    resourceId: staff.id,
    metadata: { reason },
  });
  if (lock) throw lockedError();
  throw unauthorized("Email or password is incorrect");
}

const lockedError = () =>
  new AppError("locked", `Too many failed attempts. Try again in ${LOCKOUT_MINUTES} minutes.`);

function assertUsable(deps: CoreDeps, staff: StaffRow) {
  if (staff.disabledAt) throw unauthorized("Email or password is incorrect");
  if (staff.lockedUntil && staff.lockedUntil > now(deps)) throw lockedError();
}

async function completeLogin(deps: CoreDeps, staff: StaffRow, actor: Actor, totpStep?: number): Promise<LoginResult> {
  await deps.db
    .update(staffUsers)
    .set({ failedLoginCount: 0, lockedUntil: null, lastLoginAt: now(deps), ...(totpStep !== undefined ? { totpLastStep: totpStep } : {}) })
    .where(eq(staffUsers.id, staff.id));
  await writeAudit(deps.db, { ...actor, type: "staff", id: staff.id }, {
    storeId: staff.storeId,
    action: "staff.login",
    resourceType: "staff_user",
    resourceId: staff.id,
  });
  const { token, session } = await createSession(deps.redis, staff.id, staff.storeId);
  return { status: "ok", token, csrf: session.csrf, staff: await staffView(deps.db, staff) };
}

/** Password step. Lockout after 5 failures for 15 minutes; unknown emails cost the same time. */
export async function login(deps: CoreDeps, storeId: string, input: z.input<typeof loginInput>, actor: Actor): Promise<LoginResult> {
  const { email, password } = loginInput.parse(input);
  const [staff] = await deps.db.select().from(staffUsers).where(and(eq(staffUsers.storeId, storeId), eq(staffUsers.email, email)));
  if (!staff) {
    await verifyDummy(password);
    throw unauthorized("Email or password is incorrect");
  }
  assertUsable(deps, staff);
  if (!(await verifyPassword(staff.passwordHash, password))) return recordFailure(deps, staff, actor, "password");
  if (staff.totpEnabled) {
    const challenge = randomToken();
    await deps.redis.set(challengeKey(challenge), staff.id, "EX", 300);
    return { status: "totp_required", challenge };
  }
  return completeLogin(deps, staff, actor);
}

/** Second step for staff with TOTP. Wrong codes count towards the lockout. */
export async function loginTotp(deps: CoreDeps, storeId: string, challenge: string, code: string, actor: Actor): Promise<LoginResult> {
  const staffId = await deps.redis.get(challengeKey(challenge));
  if (!staffId) throw unauthorized("Sign-in expired, start again");
  const staff = await getStaff(deps.db, storeId, staffId);
  if (!staff?.totpSecret) throw unauthorized("Sign-in expired, start again");
  assertUsable(deps, staff);
  const { secret } = openJson<{ secret: string }>(staff.totpSecret, totpAad(staff.storeId, staff.id), deps.keyring);
  const step = verifyTotp(secret, code, now(deps), staff.totpLastStep);
  if (step === null) return recordFailure(deps, staff, actor, "totp");
  await deps.redis.del(challengeKey(challenge));
  return completeLogin(deps, staff, actor, step);
}

// ── TOTP enrolment ─────────────────────────────────────────────────────────
const pendingKey = (staffId: string) => `sk:totp-pending:${staffId}`;

export async function startTotpEnrollment(deps: CoreDeps, storeId: string, staffId: string) {
  const staff = await getStaff(deps.db, storeId, staffId);
  if (!staff) throw unauthorized();
  const store = await getStore(deps.db, storeId);
  const secret = generateTotpSecret();
  // Pending secret is sealed in Redis too; it only becomes active after a correct code.
  await deps.redis.set(pendingKey(staffId), JSON.stringify(sealJson({ secret }, totpAad(storeId, staffId), deps.keyring)), "EX", 600);
  return { secret, otpauthUrl: otpauthUrl(secret, staff.email, store.name || "Shopkit") };
}

export async function confirmTotpEnrollment(deps: CoreDeps, actor: Actor, storeId: string, staffId: string, code: string) {
  const raw = await deps.redis.get(pendingKey(staffId));
  if (!raw) throw new AppError("bad_request", "Start two-factor setup again");
  const aad = totpAad(storeId, staffId);
  const { secret } = openJson<{ secret: string }>(JSON.parse(raw) as Parameters<typeof openJson>[0], aad, deps.keyring);
  const step = verifyTotp(secret, totpCodeInput.parse({ code }).code, now(deps));
  if (step === null) throw new AppError("validation_failed", "That code is not valid. Check your device's clock.", { field: "code" });
  await deps.db.transaction(async (tx) => {
    await tx
      .update(staffUsers)
      .set({ totpEnabled: true, totpSecret: sealJson({ secret }, aad, deps.keyring), totpLastStep: step })
      .where(and(eq(staffUsers.storeId, storeId), eq(staffUsers.id, staffId)));
    await writeAudit(tx, actor, { storeId, action: "staff.totp_enabled", resourceType: "staff_user", resourceId: staffId });
  });
  await deps.redis.del(pendingKey(staffId));
}

export async function disableTotp(deps: CoreDeps, actor: Actor, storeId: string, staffId: string, password: string, currentToken?: string) {
  const staff = await getStaff(deps.db, storeId, staffId);
  if (!staff || !(await verifyPassword(staff.passwordHash, password))) throw unauthorized("Password is incorrect");
  await deps.db.transaction(async (tx) => {
    await tx.update(staffUsers).set({ totpEnabled: false, totpSecret: null, totpLastStep: null }).where(eq(staffUsers.id, staffId));
    await writeAudit(tx, actor, { storeId, action: "staff.totp_disabled", resourceType: "staff_user", resourceId: staffId });
  });
  await destroyAllSessions(deps.redis, staffId, currentToken);
}

export const ownerInput = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.email().max(254),
  password: z.string().max(256),
});

/** Creates or updates the store owner during setup. */
export async function upsertOwner(deps: CoreDeps, actor: Actor, storeId: string, input: z.input<typeof ownerInput>, db: Executor) {
  const owner = ownerInput.parse(input);
  await assertStrongPassword(owner.password, [owner.name, owner.email, ...owner.email.split("@")]);
  const roleIds = await ensureSystemRoles(db, storeId);
  const passwordHash = await hashPassword(owner.password);
  const [existing] = await db.select().from(staffUsers).where(and(eq(staffUsers.storeId, storeId), eq(staffUsers.roleId, roleIds.owner)));
  let staffId: string;
  if (existing) {
    await db.update(staffUsers).set({ name: owner.name, email: owner.email, passwordHash }).where(eq(staffUsers.id, existing.id));
    staffId = existing.id;
  } else {
    const [row] = await db
      .insert(staffUsers)
      .values({ storeId, roleId: roleIds.owner, name: owner.name, email: owner.email, passwordHash })
      .returning();
    staffId = row!.id;
  }
  await writeAudit(db, actor, { storeId, action: existing ? "staff.owner_updated" : "staff.owner_created", resourceType: "staff_user", resourceId: staffId });
  return staffId;
}

export async function listStaff(db: Executor, storeId: string) {
  const rows = await db.select().from(staffUsers).where(eq(staffUsers.storeId, storeId)).orderBy(staffUsers.createdAt);
  return Promise.all(rows.map((r) => staffView(db, r)));
}
