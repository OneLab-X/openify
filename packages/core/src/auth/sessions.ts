import { randomToken, sha256Hex } from "@shopkit/crypto";
import type { Redis } from "ioredis";

/** Redis-backed staff sessions (SPEC §10): opaque token in an httpOnly cookie, 8-hour idle timeout. */
export const SESSION_IDLE_SECONDS = 8 * 60 * 60;

export interface StaffSession {
  staffId: string;
  storeId: string;
  csrf: string;
  createdAt: string;
}

const key = (token: string) => `sk:sess:${sha256Hex(token)}`;
const indexKey = (staffId: string) => `sk:staff-sess:${staffId}`;

export async function createSession(redis: Redis, staffId: string, storeId: string) {
  const token = randomToken();
  const session: StaffSession = { staffId, storeId, csrf: randomToken(24), createdAt: new Date().toISOString() };
  await redis
    .multi()
    .set(key(token), JSON.stringify(session), "EX", SESSION_IDLE_SECONDS)
    .sadd(indexKey(staffId), sha256Hex(token))
    .expire(indexKey(staffId), SESSION_IDLE_SECONDS * 3)
    .exec();
  return { token, session };
}

/** Loads a session and slides its idle timeout. */
export async function touchSession(redis: Redis, token: string): Promise<StaffSession | null> {
  if (!token || token.length > 200) return null;
  const raw = await redis.getex(key(token), "EX", SESSION_IDLE_SECONDS);
  return raw ? (JSON.parse(raw) as StaffSession) : null;
}

export async function destroySession(redis: Redis, token: string): Promise<void> {
  await redis.del(key(token));
}

/** Signs a staff member out everywhere (password change, disable, 2FA reset). */
export async function destroyAllSessions(redis: Redis, staffId: string, exceptToken?: string): Promise<void> {
  const hashes = await redis.smembers(indexKey(staffId));
  const keep = exceptToken ? sha256Hex(exceptToken) : null;
  const drop = hashes.filter((h) => h !== keep);
  if (drop.length) await redis.del(...drop.map((h) => `sk:sess:${h}`));
  await redis.del(indexKey(staffId));
  if (keep) await redis.sadd(indexKey(staffId), keep);
}
