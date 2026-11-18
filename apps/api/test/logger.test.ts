import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";

describe("logger redaction", () => {
  it("never writes secrets, cookies or auth headers", () => {
    let out = "";
    const sink = new Writable({ write(chunk: Buffer, _e, cb) { out += chunk.toString(); cb(); } });
    const log = createLogger({ LOG_LEVEL: "info" }, sink);
    log.info({
      req: { headers: { authorization: "Bearer AUTHVALUE", cookie: "sk_session=COOKIEVALUE", "x-setup-token": "SETUPVALUE" } },
      body: { password: "PWVALUE", secrets: { keySecret: "KEYVALUE" }, apiKey: "APIVALUE" },
    }, "request");
    expect(out).toContain("[redacted]");
    for (const v of ["AUTHVALUE", "COOKIEVALUE", "SETUPVALUE", "PWVALUE", "KEYVALUE", "APIVALUE"]) expect(out).not.toContain(v);
  });
});

describe("config", () => {
  it("validates required env and never needs provider secrets", () => {
    expect(() => loadConfig({})).toThrow(/DATABASE_URL/);
    const c = loadConfig({ DATABASE_URL: "postgres://x", REDIS_URL: "redis://x", PUBLIC_URL: "https://shop.test/", SESSION_SECRET: "s".repeat(32) });
    expect(c.PUBLIC_URL).toBe("https://shop.test");
    expect(() => loadConfig({ DATABASE_URL: "x", REDIS_URL: "x", PUBLIC_URL: "https://a.b", SESSION_SECRET: "short" })).toThrow(/SESSION_SECRET/);
  });
});
