import { auditLogs, staffUsers, stores } from "@shopkit/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { totpCode } from "../src/auth/totp.js";
import { confirmTotpEnrollment, disableTotp, login, loginTotp, startTotpEnrollment, upsertOwner, listStaff } from "../src/auth/staff.js";
import { createSession, destroyAllSessions, destroySession, touchSession } from "../src/auth/sessions.js";
import { AppError } from "../src/errors.js";
import { ACTOR, makeDeps, STRONG_PASSWORD, type TestDeps } from "./harness.js";

let deps: TestDeps;
let storeId: string;
let ownerId: string;
let clock = new Date("2026-11-19T10:00:00Z");
beforeAll(async () => {
  deps = await makeDeps();
  deps.now = () => clock;
});
afterAll(() => deps.close());
beforeEach(async () => {
  await deps.reset();
  clock = new Date("2026-11-19T10:00:00Z");
  storeId = (await deps.db.insert(stores).values({ name: "Shop" }).returning())[0]!.id;
  ownerId = await upsertOwner(deps, ACTOR, storeId, { name: "Asha", email: "Asha@Example.com", password: STRONG_PASSWORD }, deps.db);
});

const creds = { email: "asha@example.com", password: STRONG_PASSWORD };

describe("login", () => {
  it("signs in with a case-insensitive email and returns a session", async () => {
    const res = await login(deps, storeId, creds, ACTOR);
    expect(res.status).toBe("ok");
    if (res.status !== "ok") return;
    expect(res.staff).toMatchObject({ role: "owner", permissions: ["*"], email: "Asha@Example.com" });
    expect(await touchSession(deps.redis, res.token)).toMatchObject({ staffId: ownerId, storeId, csrf: res.csrf });
    expect((await deps.db.select().from(auditLogs)).map((a) => a.action)).toContain("staff.login");
  });

  it("rejects unknown emails and wrong passwords with the same message", async () => {
    await expect(login(deps, storeId, { ...creds, email: "x@example.com" }, ACTOR)).rejects.toThrow("Email or password is incorrect");
    await expect(login(deps, storeId, { ...creds, password: "wrong" }, ACTOR)).rejects.toThrow("Email or password is incorrect");
  });

  it("locks the account for 15 minutes after 5 failures, even for the right password", async () => {
    for (let i = 0; i < 4; i++) await expect(login(deps, storeId, { ...creds, password: "bad" }, ACTOR)).rejects.toMatchObject({ code: "unauthorized" });
    await expect(login(deps, storeId, { ...creds, password: "bad" }, ACTOR)).rejects.toMatchObject({ code: "locked" });
    await expect(login(deps, storeId, creds, ACTOR)).rejects.toMatchObject({ code: "locked" });
    clock = new Date(clock.getTime() + 16 * 60_000);
    await expect(login(deps, storeId, creds, ACTOR)).resolves.toMatchObject({ status: "ok" });
    const [staff] = await deps.db.select().from(staffUsers);
    expect(staff).toMatchObject({ failedLoginCount: 0, lockedUntil: null });
  });

  it("disabled staff cannot sign in", async () => {
    await deps.db.update(staffUsers).set({ disabledAt: new Date() });
    await expect(login(deps, storeId, creds, ACTOR)).rejects.toMatchObject({ code: "unauthorized" });
  });
});

describe("TOTP", () => {
  async function enroll() {
    const { secret, otpauthUrl } = await startTotpEnrollment(deps, storeId, ownerId);
    expect(otpauthUrl).toContain("otpauth://totp/Shop");
    await expect(confirmTotpEnrollment(deps, ACTOR, storeId, ownerId, "000000")).rejects.toThrow(AppError);
    await confirmTotpEnrollment(deps, ACTOR, storeId, ownerId, totpCode(secret, clock));
    return secret;
  }

  it("enrolment stores the secret encrypted and login requires a code", async () => {
    const secret = await enroll();
    const [staff] = await deps.db.select().from(staffUsers);
    expect(staff!.totpEnabled).toBe(true);
    expect(JSON.stringify(staff!.totpSecret)).not.toContain(secret);

    const first = await login(deps, storeId, creds, ACTOR);
    expect(first.status).toBe("totp_required");
    if (first.status !== "totp_required") return;
    clock = new Date(clock.getTime() + 30_000);
    await expect(loginTotp(deps, storeId, first.challenge, "123456", ACTOR)).rejects.toMatchObject({ code: "unauthorized" });
    const ok = await loginTotp(deps, storeId, first.challenge, totpCode(secret, clock), ACTOR);
    expect(ok.status).toBe("ok");
    await expect(loginTotp(deps, storeId, first.challenge, totpCode(secret, clock), ACTOR)).rejects.toThrow(/expired/);
  });

  it("rejects a replayed code", async () => {
    const secret = await enroll();
    const first = await login(deps, storeId, creds, ACTOR);
    if (first.status !== "totp_required") throw new Error("expected challenge");
    // The enrolment code's step is already used.
    await expect(loginTotp(deps, storeId, first.challenge, totpCode(secret, clock), ACTOR)).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("can be disabled with the password, which signs out other sessions", async () => {
    await enroll();
    const keep = await createSession(deps.redis, ownerId, storeId);
    const other = await createSession(deps.redis, ownerId, storeId);
    await expect(disableTotp(deps, ACTOR, storeId, ownerId, "wrong")).rejects.toThrow(/incorrect/);
    await disableTotp(deps, ACTOR, storeId, ownerId, STRONG_PASSWORD, keep.token);
    expect(await touchSession(deps.redis, keep.token)).not.toBeNull();
    expect(await touchSession(deps.redis, other.token)).toBeNull();
    expect((await listStaff(deps.db, storeId))[0]!.totpEnabled).toBe(false);
  });

  it("confirm without start fails", async () => {
    await expect(confirmTotpEnrollment(deps, ACTOR, storeId, ownerId, "123456")).rejects.toThrow(/again/);
  });
});

describe("sessions", () => {
  it("expire after 8 idle hours and can be destroyed", async () => {
    const { token } = await createSession(deps.redis, ownerId, storeId);
    const ttl = await deps.redis.ttl(`sk:sess:${(await import("@shopkit/crypto")).sha256Hex(token)}`);
    expect(ttl).toBeGreaterThan(8 * 3600 - 5);
    expect(await touchSession(deps.redis, "")).toBeNull();
    await destroySession(deps.redis, token);
    expect(await touchSession(deps.redis, token)).toBeNull();
    const a = await createSession(deps.redis, ownerId, storeId);
    await destroyAllSessions(deps.redis, ownerId);
    expect(await touchSession(deps.redis, a.token)).toBeNull();
  });
});
