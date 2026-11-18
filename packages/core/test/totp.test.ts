import { describe, expect, it } from "vitest";
import { base32Decode, base32Encode, generateTotpSecret, hotp, otpauthUrl, totpCode, totpStep, verifyTotp } from "../src/auth/totp.js";

// RFC 6238 Appendix B, SHA-1 seed "12345678901234567890"; 6-digit codes are the last 6 digits.
const seed = base32Encode(Buffer.from("12345678901234567890"));
const vectors: [number, string][] = [
  [59, "287082"], [1111111109, "081804"], [1111111111, "050471"], [1234567890, "005924"], [2000000000, "279037"],
];

describe("totp", () => {
  it("base32 round-trips", () => {
    const buf = Buffer.from("any carnal pleas");
    expect(base32Decode(base32Encode(buf))).toEqual(buf);
    expect(base32Encode(Buffer.from("f"))).toBe("MY");
    expect(base32Decode("my======")).toEqual(Buffer.from("f"));
    expect(() => base32Decode("1")).toThrow(TypeError);
  });

  it.each(vectors)("matches RFC 6238 at t=%i", (t, code) => {
    expect(totpCode(seed, new Date(t * 1000))).toBe(code);
  });

  it("RFC 4226 HOTP vector", () => {
    expect(hotp(Buffer.from("12345678901234567890"), 1)).toBe("287082");
  });

  it("accepts ±1 step and rejects replays", () => {
    const at = new Date(1_700_000_000_000);
    const prev = totpCode(seed, new Date(at.getTime() - 30_000));
    expect(verifyTotp(seed, prev, at)).toBe(totpStep(at) - 1);
    expect(verifyTotp(seed, totpCode(seed, new Date(at.getTime() - 90_000)), at)).toBeNull();
    const step = verifyTotp(seed, totpCode(seed, at), at)!;
    expect(verifyTotp(seed, totpCode(seed, at), at, step)).toBeNull();
    expect(verifyTotp(seed, "12345", at)).toBeNull();
  });

  it("generates 160-bit secrets and otpauth URLs", () => {
    const secret = generateTotpSecret();
    expect(base32Decode(secret)).toHaveLength(20);
    const url = new URL(otpauthUrl(secret, "a@b.co", "My Shop"));
    expect(url.protocol).toBe("otpauth:");
    expect(url.searchParams.get("secret")).toBe(secret);
    expect(url.searchParams.get("issuer")).toBe("My Shop");
  });
});
