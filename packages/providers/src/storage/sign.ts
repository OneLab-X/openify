import { createHmac, timingSafeEqual } from "node:crypto";

export function hmacHex(secret: string, value: string): string {
  return createHmac("sha256", secret).update(value).digest("hex");
}

/** Verifies a local signed media URL (see local storage getSignedUrl). */
export function verifyLocalSignature(
  secret: string,
  storeId: string,
  key: string,
  exp: number,
  sig: string,
  now = Date.now(),
): boolean {
  if (!Number.isFinite(exp) || exp * 1000 < now || !/^[0-9a-f]{64}$/.test(sig)) return false;
  const expected = Buffer.from(hmacHex(secret, `${storeId}/${key}:${exp}`), "hex");
  return timingSafeEqual(expected, Buffer.from(sig, "hex"));
}
