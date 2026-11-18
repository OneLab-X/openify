import { describe, expect, it } from "vitest";
import { UUID_RE, uuidv7 } from "./uuid.js";

describe("uuidv7", () => {
  it("is a valid version-7 UUID with variant bits", () => {
    const id = uuidv7();
    expect(id).toMatch(UUID_RE);
    expect(id[14]).toBe("7");
    expect("89ab").toContain(id[19]);
  });

  it("encodes the timestamp in the first 48 bits so ids sort by time", () => {
    const t = Date.UTC(2026, 0, 1);
    const id = uuidv7(t);
    expect(parseInt(id.replace(/-/g, "").slice(0, 12), 16)).toBe(t);
    expect(uuidv7(t) < uuidv7(t + 1)).toBe(true);
  });

  it("is unique", () => {
    const ids = new Set(Array.from({ length: 10_000 }, () => uuidv7()));
    expect(ids.size).toBe(10_000);
  });
});
