import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { keyFor, KeyringError, loadKeyring, parseKey } from "./keyring.js";

const k = () => randomBytes(32).toString("base64");

describe("loadKeyring", () => {
  it("uses SHOPKIT_MASTER_KEY as version 1 by default", () => {
    const key = k();
    const ring = loadKeyring({ SHOPKIT_MASTER_KEY: key });
    expect(ring.current).toBe(1);
    expect(ring.keys.get(1)?.toString("base64")).toBe(key);
  });

  it("loads versioned keys and honours SHOPKIT_MASTER_KEY_VERSION", () => {
    const ring = loadKeyring({ SHOPKIT_MASTER_KEY_1: k(), SHOPKIT_MASTER_KEY_2: k(), SHOPKIT_MASTER_KEY_VERSION: "2" });
    expect(ring.current).toBe(2);
    expect([...ring.keys.keys()].sort()).toEqual([1, 2]);
  });

  it("ignores empty and unrelated variables", () => {
    const ring = loadKeyring({ SHOPKIT_MASTER_KEY: k(), SHOPKIT_MASTER_KEY_3: "", OTHER: "x" });
    expect([...ring.keys.keys()]).toEqual([1]);
  });

  it("accepts SHOPKIT_MASTER_KEY equal to the versioned key", () => {
    const key = k();
    const ring = loadKeyring({ SHOPKIT_MASTER_KEY: key, SHOPKIT_MASTER_KEY_1: key });
    expect(ring.keys.size).toBe(1);
  });

  it("rejects SHOPKIT_MASTER_KEY that differs from the versioned key", () => {
    expect(() => loadKeyring({ SHOPKIT_MASTER_KEY: k(), SHOPKIT_MASTER_KEY_1: k() })).toThrow(KeyringError);
  });

  it("fails when the current version has no key", () => {
    expect(() => loadKeyring({})).toThrow(/No master key for version 1/);
    expect(() => loadKeyring({ SHOPKIT_MASTER_KEY_1: k(), SHOPKIT_MASTER_KEY_VERSION: "2" })).toThrow(
      /version 2/,
    );
  });

  it("rejects malformed versions and keys", () => {
    expect(() => loadKeyring({ SHOPKIT_MASTER_KEY: k(), SHOPKIT_MASTER_KEY_VERSION: "0" })).toThrow(
      /positive integer/,
    );
    expect(() => loadKeyring({ SHOPKIT_MASTER_KEY_0: k() })).toThrow(/positive integer/);
    expect(() => loadKeyring({ SHOPKIT_MASTER_KEY: "c2hvcnQ=" })).toThrow(/32 bytes/);
  });

  it("reads process.env by default", () => {
    const before = process.env.SHOPKIT_MASTER_KEY;
    process.env.SHOPKIT_MASTER_KEY = k();
    try {
      expect(loadKeyring().current).toBe(1);
    } finally {
      if (before === undefined) delete process.env.SHOPKIT_MASTER_KEY;
      else process.env.SHOPKIT_MASTER_KEY = before;
    }
  });
});

describe("parseKey / keyFor", () => {
  it("trims whitespace", () => {
    expect(parseKey("X", ` ${k()}\n`)).toHaveLength(32);
  });

  it("throws for unknown versions", () => {
    const ring = loadKeyring({ SHOPKIT_MASTER_KEY: k() });
    expect(keyFor(ring, 1)).toHaveLength(32);
    expect(() => keyFor(ring, 9)).toThrow(/version 9/);
  });
});
