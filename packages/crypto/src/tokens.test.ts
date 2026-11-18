import { describe, expect, it } from "vitest";
import { hmacSha256Hex, last4, randomToken, safeEqual, sha256Hex } from "./tokens.js";

describe("tokens", () => {
  it("randomToken is url-safe and sized", () => {
    expect(randomToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken(16)).toHaveLength(22);
  });
  it("sha256Hex / hmacSha256Hex", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(hmacSha256Hex("key", "The quick brown fox jumps over the lazy dog")).toBe(
      "f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8",
    );
  });
  it("safeEqual", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });
  it("last4", () => {
    expect(last4("rzp_test_secret_wxyz")).toBe("wxyz");
    expect(last4("short")).toBeNull();
    expect(last4(undefined)).toBeNull();
    expect(last4(null)).toBeNull();
  });
});
