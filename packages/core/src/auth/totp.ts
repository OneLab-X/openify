import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** RFC 4648 base32 (no padding), as used by authenticator apps. */
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.replace(/=+$/, "").replace(/\s+/g, "").toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const idx = ALPHABET.indexOf(char);
    if (idx === -1) throw new TypeError("Invalid base32 character");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export const TOTP_PERIOD = 30;
const DIGITS = 6;

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** RFC 4226 HOTP with SHA-1, 6 digits. */
export function hotp(secret: Buffer, counter: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac("sha1", secret).update(msg).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const code = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** DIGITS;
  return code.toString().padStart(DIGITS, "0");
}

export const totpStep = (at: Date) => Math.floor(at.getTime() / 1000 / TOTP_PERIOD);

export function totpCode(secretBase32: string, at: Date = new Date()): string {
  return hotp(base32Decode(secretBase32), totpStep(at));
}

/**
 * RFC 6238 check with ±1 step drift. Returns the matched step so callers can reject replays
 * (a step at or before the last accepted one), or null.
 */
export function verifyTotp(secretBase32: string, code: string, at: Date = new Date(), lastStep?: number | null): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const secret = base32Decode(secretBase32);
  const current = totpStep(at);
  for (const step of [current - 1, current, current + 1]) {
    if (lastStep !== undefined && lastStep !== null && step <= lastStep) continue;
    if (timingSafeEqual(Buffer.from(hotp(secret, step)), Buffer.from(code))) return step;
  }
  return null;
}

export function otpauthUrl(secretBase32: string, account: string, issuer: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({ secret: secretBase32, issuer, algorithm: "SHA1", digits: "6", period: "30" });
  return `otpauth://totp/${label}?${params.toString()}`;
}
