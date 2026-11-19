import { randomToken, sha256Hex } from "@shopkit/crypto";
import { and, asc, auditLogs, desc, eq, gte, ilike, isNull, lt, lte, or, rolePermissions, roles, sql, staffInvites, staffUsers, type Executor } from "@shopkit/db";
import { z } from "zod";
import { writeAudit } from "../audit.js";
import type { Actor, CoreDeps } from "../deps.js";
import { now } from "../deps.js";
import { AppError, notFound } from "../errors.js";
import { enqueueEvent } from "../outbox.js";
import { getSetting, setSetting } from "../settings.js";
import { getStore } from "../stores.js";
import { assertStrongPassword, hashPassword } from "./password.js";
import { PERMISSIONS } from "./permissions.js";
import { destroyAllSessions } from "./sessions.js";
import { staffView } from "./staff.js";

/**
 * Staff management (Phase 4): custom roles with granular permissions, email invitations, disabling
 * accounts, the owner-enforced two-factor requirement and the filtered audit log.
 */
const INVITE_DAYS = 7;

// ── Roles ────────────────────────────────────────────────────────────────────
export const roleInput = z.object({
  name: z.string().trim().min(1).max(60),
  permissions: z.array(z.enum(PERMISSIONS)).max(PERMISSIONS.length),
});

export async function listRoles(db: Executor, storeId: string) {
  const rows = await db.select().from(roles).where(eq(roles.storeId, storeId)).orderBy(desc(roles.isSystem), asc(roles.createdAt));
  const perms = await db.select().from(rolePermissions).where(eq(rolePermissions.storeId, storeId));
  const counts = await db.select({ roleId: staffUsers.roleId, n: sql<number>`count(*)::int` }).from(staffUsers).where(eq(staffUsers.storeId, storeId)).groupBy(staffUsers.roleId);
  return rows.map((r) => ({
    id: r.id,
    key: r.key,
    name: r.name,
    isSystem: r.isSystem,
    permissions: perms.filter((p) => p.roleId === r.id).map((p) => p.permission),
    staffCount: counts.find((c) => c.roleId === r.id)?.n ?? 0,
  }));
}

export async function saveRole(deps: CoreDeps, actor: Actor, storeId: string, input: z.input<typeof roleInput>, id?: string) {
  const d = roleInput.parse(input);
  return deps.db.transaction(async (tx) => {
    let roleId = id;
    if (id) {
      const [r] = await tx.select().from(roles).where(and(eq(roles.storeId, storeId), eq(roles.id, id)));
      if (!r) throw notFound("Role");
      if (r.isSystem) throw new AppError("conflict", "Built-in roles can't be edited; create a custom role instead");
      await tx.update(roles).set({ name: d.name }).where(eq(roles.id, id));
      await tx.delete(rolePermissions).where(eq(rolePermissions.roleId, id));
    } else {
      const key = `custom-${randomToken(6).toLowerCase()}`;
      const [r] = await tx.insert(roles).values({ storeId, key, name: d.name, isSystem: false }).returning({ id: roles.id });
      roleId = r!.id;
    }
    const perms = [...new Set(d.permissions)];
    if (perms.length) await tx.insert(rolePermissions).values(perms.map((permission) => ({ storeId, roleId: roleId!, permission })));
    await writeAudit(tx, actor, { storeId, action: id ? "role.updated" : "role.created", resourceType: "role", resourceId: roleId!, metadata: { permissions: perms } });
    return roleId!;
  });
}

export async function deleteRole(deps: CoreDeps, actor: Actor, storeId: string, id: string) {
  await deps.db.transaction(async (tx) => {
    const [r] = await tx.select().from(roles).where(and(eq(roles.storeId, storeId), eq(roles.id, id)));
    if (!r) throw notFound("Role");
    if (r.isSystem) throw new AppError("conflict", "Built-in roles can't be deleted");
    const [used] = await tx.select({ n: sql<number>`count(*)::int` }).from(staffUsers).where(eq(staffUsers.roleId, id));
    if ((used?.n ?? 0) > 0) throw new AppError("conflict", "Move the staff in this role to another role first");
    await tx.delete(staffInvites).where(eq(staffInvites.roleId, id));
    await tx.delete(roles).where(eq(roles.id, id));
    await writeAudit(tx, actor, { storeId, action: "role.deleted", resourceType: "role", resourceId: id });
  });
}

async function assignableRole(db: Executor, storeId: string, roleId: string) {
  const [r] = await db.select().from(roles).where(and(eq(roles.storeId, storeId), eq(roles.id, roleId)));
  if (!r) throw notFound("Role");
  if (r.key === "owner") throw new AppError("validation_failed", "There is one owner per store");
  return r;
}

// ── Invitations ──────────────────────────────────────────────────────────────
export const inviteInput = z.object({ email: z.email().max(254), name: z.string().trim().max(120).optional(), roleId: z.uuid() });

const inviteUrl = (deps: CoreDeps, token: string) => `${deps.runtime.publicUrl}/admin/invite/${token}`;

export async function inviteStaff(deps: CoreDeps, actor: Actor, storeId: string, input: z.input<typeof inviteInput>) {
  const d = inviteInput.parse(input);
  return deps.db.transaction(async (tx) => {
    await assignableRole(tx, storeId, d.roleId);
    const [existing] = await tx.select().from(staffUsers).where(and(eq(staffUsers.storeId, storeId), eq(staffUsers.email, d.email)));
    if (existing) throw new AppError("conflict", `${d.email} already has a staff account`);
    // A new invite replaces any open one for the same address.
    await tx.update(staffInvites).set({ revokedAt: now(deps) }).where(and(eq(staffInvites.storeId, storeId), eq(staffInvites.email, d.email), isNull(staffInvites.acceptedAt), isNull(staffInvites.revokedAt)));
    const token = randomToken();
    const [inv] = await tx
      .insert(staffInvites)
      .values({ storeId, email: d.email, name: d.name ?? null, roleId: d.roleId, tokenHash: sha256Hex(token), invitedBy: actor.id ?? null, expiresAt: new Date(now(deps).getTime() + INVITE_DAYS * 86_400_000) })
      .returning();
    await enqueueEvent(tx, { storeId, type: "staff.invited", payload: { inviteId: inv!.id, email: d.email, acceptUrl: inviteUrl(deps, token) } });
    await writeAudit(tx, actor, { storeId, action: "staff.invited", resourceType: "staff_invite", resourceId: inv!.id, metadata: { email: d.email, roleId: d.roleId } });
    return { id: inv!.id, acceptUrl: inviteUrl(deps, token) };
  });
}

export async function listInvites(db: Executor, storeId: string, at: Date = new Date()) {
  const rows = await db
    .select({ i: staffInvites, roleName: roles.name })
    .from(staffInvites)
    .innerJoin(roles, eq(roles.id, staffInvites.roleId))
    .where(and(eq(staffInvites.storeId, storeId), isNull(staffInvites.acceptedAt), isNull(staffInvites.revokedAt)))
    .orderBy(desc(staffInvites.createdAt));
  return rows.map(({ i, roleName }) => ({ id: i.id, email: i.email, name: i.name, roleId: i.roleId, roleName, expiresAt: i.expiresAt.toISOString(), expired: i.expiresAt <= at, createdAt: i.createdAt.toISOString() }));
}

export async function revokeInvite(deps: CoreDeps, actor: Actor, storeId: string, id: string) {
  const [row] = await deps.db.update(staffInvites).set({ revokedAt: now(deps) }).where(and(eq(staffInvites.storeId, storeId), eq(staffInvites.id, id), isNull(staffInvites.acceptedAt))).returning({ id: staffInvites.id });
  if (!row) throw notFound("Invitation");
  await writeAudit(deps.db, actor, { storeId, action: "staff.invite_revoked", resourceType: "staff_invite", resourceId: id });
}

async function openInvite(db: Executor, token: string, at: Date) {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) throw notFound("Invitation");
  const [inv] = await db.select().from(staffInvites).where(eq(staffInvites.tokenHash, sha256Hex(token)));
  if (!inv || inv.revokedAt || inv.acceptedAt) throw notFound("Invitation");
  if (inv.expiresAt <= at) throw new AppError("conflict", "This invitation has expired; ask for a new one");
  return inv;
}

/** Public: what the accept page shows. */
export async function describeInvite(deps: CoreDeps, token: string) {
  const inv = await openInvite(deps.db, token, now(deps));
  const store = await getStore(deps.db, inv.storeId);
  const [role] = await deps.db.select({ name: roles.name }).from(roles).where(eq(roles.id, inv.roleId));
  return { email: inv.email, name: inv.name, storeName: store.name, roleName: role?.name ?? "Staff" };
}

export const acceptInviteInput = z.object({ name: z.string().trim().min(1).max(120), password: z.string().max(256) });

export async function acceptInvite(deps: CoreDeps, token: string, input: z.input<typeof acceptInviteInput>, meta: { ip?: string | null; userAgent?: string | null } = {}) {
  const d = acceptInviteInput.parse(input);
  const inv = await openInvite(deps.db, token, now(deps));
  await assertStrongPassword(d.password, [d.name, inv.email, ...inv.email.split("@")]);
  const passwordHash = await hashPassword(d.password);
  return deps.db.transaction(async (tx) => {
    const [locked] = await tx.select().from(staffInvites).where(eq(staffInvites.id, inv.id)).for("update");
    if (locked?.acceptedAt) throw new AppError("conflict", "This invitation was already used");
    const [clash] = await tx.select({ id: staffUsers.id }).from(staffUsers).where(and(eq(staffUsers.storeId, inv.storeId), eq(staffUsers.email, inv.email)));
    if (clash) throw new AppError("conflict", "An account with this email already exists");
    const [staff] = await tx.insert(staffUsers).values({ storeId: inv.storeId, roleId: inv.roleId, name: d.name, email: inv.email, passwordHash }).returning();
    await tx.update(staffInvites).set({ acceptedAt: now(deps) }).where(eq(staffInvites.id, inv.id));
    await writeAudit(tx, { type: "staff", id: staff!.id, ip: meta.ip ?? null, userAgent: meta.userAgent ?? null }, { storeId: inv.storeId, action: "staff.invite_accepted", resourceType: "staff_user", resourceId: staff!.id });
    return { staffId: staff!.id, email: inv.email };
  });
}

// ── Staff accounts ───────────────────────────────────────────────────────────
export const staffUpdateInput = z.object({ roleId: z.uuid().optional(), disabled: z.boolean().optional(), name: z.string().trim().min(1).max(120).optional() });

export async function updateStaffMember(deps: CoreDeps, actor: Actor, storeId: string, staffId: string, input: z.input<typeof staffUpdateInput>) {
  const d = staffUpdateInput.parse(input);
  await deps.db.transaction(async (tx) => {
    const [s] = await tx.select().from(staffUsers).where(and(eq(staffUsers.storeId, storeId), eq(staffUsers.id, staffId))).for("update");
    if (!s) throw notFound("Staff member");
    const [role] = await tx.select().from(roles).where(eq(roles.id, s.roleId));
    if (role?.key === "owner" && (d.roleId || d.disabled)) throw new AppError("conflict", "The store owner can't be changed or disabled");
    if (staffId === actor.id && d.disabled) throw new AppError("conflict", "You can't disable your own account");
    if (d.roleId) await assignableRole(tx, storeId, d.roleId);
    await tx
      .update(staffUsers)
      .set({ ...(d.roleId ? { roleId: d.roleId } : {}), ...(d.name ? { name: d.name } : {}), ...(d.disabled !== undefined ? { disabledAt: d.disabled ? (s.disabledAt ?? now(deps)) : null } : {}) })
      .where(eq(staffUsers.id, staffId));
    await writeAudit(tx, actor, { storeId, action: d.disabled ? "staff.disabled" : "staff.updated", resourceType: "staff_user", resourceId: staffId, metadata: { roleId: d.roleId ?? null, disabled: d.disabled ?? null } });
  });
  if (d.disabled || d.roleId) await destroyAllSessions(deps.redis, staffId);
}

export async function listTeam(db: Executor, storeId: string) {
  const rows = await db.select().from(staffUsers).where(eq(staffUsers.storeId, storeId)).orderBy(staffUsers.createdAt);
  return Promise.all(rows.map(async (r) => ({ ...(await staffView(db, r)), roleId: r.roleId, disabled: !!r.disabledAt, createdAt: r.createdAt.toISOString() })));
}

// ── Two-factor requirement ───────────────────────────────────────────────────
export const securityInput = z.object({ requireTwoFactor: z.boolean() });

export async function updateSecurity(deps: CoreDeps, actor: Actor, storeId: string, input: z.input<typeof securityInput>) {
  const d = securityInput.parse(input);
  if (d.requireTwoFactor && actor.id) {
    const [me] = await deps.db.select({ totp: staffUsers.totpEnabled }).from(staffUsers).where(eq(staffUsers.id, actor.id));
    if (!me?.totp) throw new AppError("conflict", "Turn on two-factor authentication for your own account first");
  }
  await setSetting(deps.db, storeId, "security.config", d);
  await writeAudit(deps.db, actor, { storeId, action: "security.updated", resourceType: "settings", resourceId: "security.config", metadata: d });
}

/** True when the store requires 2FA and this staff member has not set it up. */
export async function twoFactorSetupRequired(db: Executor, storeId: string, staff: { totpEnabled: boolean }): Promise<boolean> {
  if (staff.totpEnabled) return false;
  return (await getSetting(db, storeId, "security.config")).requireTwoFactor;
}

// ── Audit log ────────────────────────────────────────────────────────────────
export const auditQuery = z.object({
  actorId: z.uuid().optional(),
  action: z.string().trim().max(100).optional(),
  resourceType: z.string().trim().max(60).optional(),
  resourceId: z.string().trim().max(100).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(100).optional(),
});

/** Filtered audit log, newest first, with the actor's name. Cursor = last row id. */
export async function searchAudit(db: Executor, storeId: string, query: z.input<typeof auditQuery>) {
  const q = auditQuery.parse(query);
  let anchor: { createdAt: Date; id: string } | undefined;
  if (q.cursor) [anchor] = await db.select({ createdAt: auditLogs.createdAt, id: auditLogs.id }).from(auditLogs).where(and(eq(auditLogs.storeId, storeId), eq(auditLogs.id, q.cursor)));
  const rows = await db
    .select({ a: auditLogs, actorName: staffUsers.name, actorEmail: staffUsers.email })
    .from(auditLogs)
    .leftJoin(staffUsers, eq(staffUsers.id, auditLogs.actorId))
    .where(
      and(
        eq(auditLogs.storeId, storeId),
        q.actorId ? eq(auditLogs.actorId, q.actorId) : undefined,
        q.action ? ilike(auditLogs.action, `${q.action.replace(/[\\%_]/g, "\\$&")}%`) : undefined,
        q.resourceType ? eq(auditLogs.resourceType, q.resourceType) : undefined,
        q.resourceId ? eq(auditLogs.resourceId, q.resourceId) : undefined,
        q.from ? gte(auditLogs.createdAt, q.from) : undefined,
        q.to ? lte(auditLogs.createdAt, q.to) : undefined,
        anchor ? or(lt(auditLogs.createdAt, anchor.createdAt), and(eq(auditLogs.createdAt, anchor.createdAt), lt(auditLogs.id, anchor.id))) : undefined,
      ),
    )
    .orderBy(desc(auditLogs.createdAt), desc(auditLogs.id))
    .limit(q.limit + 1);
  const page = rows.slice(0, q.limit);
  const actions = await db.selectDistinct({ action: auditLogs.action }).from(auditLogs).where(eq(auditLogs.storeId, storeId)).orderBy(asc(auditLogs.action)).limit(500);
  return {
    items: page.map(({ a, actorName, actorEmail }) => ({
      id: a.id,
      actorType: a.actorType,
      actorId: a.actorId,
      actorName: actorName ?? null,
      actorEmail: actorEmail ?? null,
      action: a.action,
      resourceType: a.resourceType,
      resourceId: a.resourceId,
      ip: a.ip,
      metadata: a.metadata,
      createdAt: a.createdAt.toISOString(),
    })),
    nextCursor: rows.length > q.limit ? (page.at(-1)?.a.id ?? null) : null,
    actions: actions.map((x) => x.action),
  };
}

