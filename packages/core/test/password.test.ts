import { describe, expect, it } from "vitest";
import { assertStrongPassword, hashPassword, verifyPassword } from "../src/auth/password.js";
import { hasPermission, SYSTEM_ROLES } from "../src/auth/permissions.js";
import { AppError } from "../src/errors.js";

describe("passwords", () => {
  it("hashes with argon2id and verifies", async () => {
    const hash = await hashPassword("hunter2-but-longer");
    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(await verifyPassword(hash, "hunter2-but-longer")).toBe(true);
    expect(await verifyPassword(hash, "nope")).toBe(false);
    expect(await verifyPassword("not-a-hash", "nope")).toBe(false);
  });

  it("requires zxcvbn score ≥ 3", async () => {
    await expect(assertStrongPassword("password123")).rejects.toThrow(AppError);
    await expect(assertStrongPassword("short")).rejects.toThrow(/at least 10/);
    await expect(assertStrongPassword("x".repeat(300))).rejects.toThrow(/at most/);
    await expect(assertStrongPassword("asha.kumar.shop", ["Asha Kumar", "asha.kumar.shop"])).rejects.toThrow(/too weak/);
    await expect(assertStrongPassword("violet-Trombone-47-sunrise")).resolves.toBeUndefined();
  });
});

describe("permissions", () => {
  it("owner has everything; staff cannot touch settings", () => {
    expect(hasPermission(SYSTEM_ROLES.owner.permissions, "settings:payments")).toBe(true);
    expect(hasPermission(SYSTEM_ROLES.admin.permissions, "settings:payments")).toBe(false);
    expect(hasPermission(SYSTEM_ROLES.admin.permissions, "settings:general")).toBe(true);
    expect(hasPermission(SYSTEM_ROLES.staff.permissions, "settings:read")).toBe(false);
    expect(hasPermission(SYSTEM_ROLES.staff.permissions, "products:write")).toBe(true);
  });
});
