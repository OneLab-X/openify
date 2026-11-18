import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildAad, decryptSecret, DecryptionError, encryptSecret, rewrapSecret } from "./envelope.js";
import { KeyringError, loadKeyring } from "./keyring.js";

const k = () => randomBytes(32).toString("base64");
const ring1 = loadKeyring({ SHOPKIT_MASTER_KEY_1: k() });
const aad = buildAad({ storeId: "0190a1b2-0000-7000-8000-000000000001", kind: "payment", provider: "razorpay", mode: "test" });
const secret = { keySecret: "sk_test_abcdefghijkl", webhookSecret: "whsec_123456789" };

function flip(buf: Buffer, index = 0): Buffer {
  const copy = Buffer.from(buf);
  copy[index] = copy[index]! ^ 0x01;
  return copy;
}

describe("buildAad", () => {
  it("joins parts with |", () => {
    expect(buildAad({ storeId: "s", kind: "k", provider: "p", mode: "m" })).toBe("s|k|p|m");
  });
  it("rejects empty parts and separators", () => {
    expect(() => buildAad({ storeId: "", kind: "k", provider: "p", mode: "m" })).toThrow(TypeError);
    expect(() => buildAad({ storeId: "s", kind: "k|x", provider: "p", mode: "m" })).toThrow(TypeError);
  });
});

describe("encryptSecret / decryptSecret", () => {
  it("round-trips and never contains plaintext", () => {
    const rec = encryptSecret(secret, aad, ring1);
    expect(rec.keyVersion).toBe(1);
    expect(rec.iv).toHaveLength(12);
    expect(rec.dekIv).toHaveLength(12);
    expect(rec.authTag).toHaveLength(16);
    expect(rec.wrappedDek).toHaveLength(32);
    expect(rec.ciphertext.toString("utf8")).not.toContain("sk_test");
    expect(decryptSecret(rec, aad, ring1)).toEqual(secret);
  });

  it("uses a fresh DEK and IV per encryption", () => {
    const a = encryptSecret(secret, aad, ring1);
    const b = encryptSecret(secret, aad, ring1);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
    expect(a.wrappedDek.equals(b.wrappedDek)).toBe(false);
  });

  it("fails with the wrong AAD (row swapped to another store/provider/mode)", () => {
    const rec = encryptSecret(secret, aad, ring1);
    const other = buildAad({ storeId: "other", kind: "payment", provider: "razorpay", mode: "live" });
    expect(() => decryptSecret(rec, other, ring1)).toThrow(DecryptionError);
  });

  it.each(["ciphertext", "iv", "authTag", "wrappedDek", "dekIv", "dekTag"] as const)(
    "detects a flipped byte in %s",
    (field) => {
      const rec = encryptSecret(secret, aad, ring1);
      expect(() => decryptSecret({ ...rec, [field]: flip(rec[field]) }, aad, ring1)).toThrow(DecryptionError);
    },
  );

  it("fails with the wrong master key", () => {
    const rec = encryptSecret(secret, aad, ring1);
    const otherRing = loadKeyring({ SHOPKIT_MASTER_KEY_1: k() });
    expect(() => decryptSecret(rec, aad, otherRing)).toThrow(DecryptionError);
  });

  it("fails when key_version is relabelled", () => {
    const ring = loadKeyring({ SHOPKIT_MASTER_KEY_1: k(), SHOPKIT_MASTER_KEY_2: k() });
    const rec = encryptSecret(secret, aad, ring);
    expect(() => decryptSecret({ ...rec, keyVersion: 2 }, aad, ring)).toThrow(DecryptionError);
    expect(() => decryptSecret({ ...rec, keyVersion: 7 }, aad, ring)).toThrow(KeyringError);
  });

  it("fails when the same key is used with a relabelled version (version is in the DEK AAD)", () => {
    const key = k();
    const ring = loadKeyring({ SHOPKIT_MASTER_KEY_1: key, SHOPKIT_MASTER_KEY_2: key });
    const rec = encryptSecret(secret, aad, ring);
    expect(() => decryptSecret({ ...rec, keyVersion: 2 }, aad, ring)).toThrow(DecryptionError);
  });

  it("wraps with the current version", () => {
    const ring = loadKeyring({ SHOPKIT_MASTER_KEY_1: k(), SHOPKIT_MASTER_KEY_2: k(), SHOPKIT_MASTER_KEY_VERSION: "2" });
    expect(encryptSecret(secret, aad, ring).keyVersion).toBe(2);
  });
});

describe("rewrapSecret", () => {
  const ring = loadKeyring({ SHOPKIT_MASTER_KEY_1: k(), SHOPKIT_MASTER_KEY_2: k() });

  it("moves the DEK to a new key version without touching the payload", () => {
    const rec = encryptSecret(secret, aad, ring);
    const moved = rewrapSecret(rec, aad, ring, 2);
    expect(moved.keyVersion).toBe(2);
    expect(moved.ciphertext.equals(rec.ciphertext)).toBe(true);
    expect(moved.wrappedDek.equals(rec.wrappedDek)).toBe(false);
    expect(decryptSecret(moved, aad, ring)).toEqual(secret);
    const ring2only = loadKeyring({ SHOPKIT_MASTER_KEY_2: ring.keys.get(2)!.toString("base64"), SHOPKIT_MASTER_KEY_VERSION: "2" });
    expect(decryptSecret(moved, aad, ring2only)).toEqual(secret);
  });

  it("refuses to rewrap a tampered record", () => {
    const rec = encryptSecret(secret, aad, ring);
    expect(() => rewrapSecret({ ...rec, dekTag: flip(rec.dekTag) }, aad, ring, 2)).toThrow(DecryptionError);
  });
});
