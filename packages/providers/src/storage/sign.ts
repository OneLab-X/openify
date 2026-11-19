import { createHmac, timingSafeEqual } from "node:crypto";
import type { ProviderRuntime } from "../types.js";
import { assertSafeKey, encodeKey } from "./keys.js";

export function hmacHex(secret: string, value: string): string {
  return createHmac("sha256", secret).update(value).digest("hex");
}

const payload = (storeId: string, provider: string, key: string, exp: number) => `${storeId}/${provider}/${key}:${exp}`;

/**
 * Signed `/media/s/<store>/<provider>/<key>` URL served by the API proxy. Used by providers without
 * native signed URLs (local disk, Google Drive).
 */
export function signProxyUrl(runtime: ProviderRuntime, storeId: string, provider: string, key: string, expiresIn: number): string {
  const exp = Math.floor(Date.now() / 1000) + expiresIn;
  const sig = hmacHex(runtime.signingSecret, payload(storeId, provider, assertSafeKey(key), exp));
  return `${runtime.publicUrl}/media/s/${storeId}/${encodeURIComponent(provider)}/${encodeKey(key)}?exp=${exp}&sig=${sig}`;
}

/** Verifies a URL produced by signProxyUrl. */
export function verifyProxySignature(
  secret: string,
  storeId: string,
  provider: string,
  key: string,
  exp: number,
  sig: string,
  now = Date.now(),
): boolean {
  if (!Number.isFinite(exp) || exp * 1000 < now || !/^[0-9a-f]{64}$/.test(sig)) return false;
  const expected = Buffer.from(hmacHex(secret, payload(storeId, provider, key, exp)), "hex");
  return timingSafeEqual(expected, Buffer.from(sig, "hex"));
}
