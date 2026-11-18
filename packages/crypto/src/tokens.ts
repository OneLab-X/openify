import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** URL-safe random token (default 32 bytes of entropy). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function hmacSha256Hex(secret: string | Buffer, value: string | Buffer): string {
  return createHmac("sha256", secret).update(value).digest("hex");
}

/** Constant-time string comparison; unequal lengths compare a digest so timing stays flat. */
export function safeEqual(a: string, b: string): boolean {
  const da = createHash("sha256").update(a).digest();
  const db = createHash("sha256").update(b).digest();
  return timingSafeEqual(da, db) && a.length === b.length;
}

/** Last four characters of a secret, for display only. Short secrets show nothing. */
export function last4(secret: string | undefined | null): string | null {
  if (!secret || secret.length < 8) return null;
  return secret.slice(-4);
}
