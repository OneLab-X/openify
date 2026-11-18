import { randomToken, sha256Hex } from "@shopkit/crypto";
import type { Redis } from "ioredis";

/**
 * One-time setup token (SPEC §5). Only its hash is stored. Each API replica issues its own token
 * at boot while setup is required and prints it to its logs; any issued token is accepted.
 */
const TOKENS_KEY = "sk:setup:tokens";
const TTL_SECONDS = 7 * 24 * 60 * 60;

export async function issueSetupToken(redis: Redis): Promise<string> {
  const token = randomToken(24);
  await redis.multi().sadd(TOKENS_KEY, sha256Hex(token)).expire(TOKENS_KEY, TTL_SECONDS).exec();
  return token;
}

export async function isValidSetupToken(redis: Redis, token: string | undefined | null): Promise<boolean> {
  if (!token || token.length > 128) return false;
  return (await redis.sismember(TOKENS_KEY, sha256Hex(token.trim()))) === 1;
}

export async function clearSetupTokens(redis: Redis): Promise<void> {
  await redis.del(TOKENS_KEY);
}
