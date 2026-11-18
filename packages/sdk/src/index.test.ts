import { describe, expect, it } from "vitest";
import { createShopkitClient, errorMessage, fieldErrors } from "./index.js";

describe("sdk", () => {
  it("adds the CSRF cookie to writes and sends credentials", async () => {
    const seen: Request[] = [];
    (globalThis as { document?: { cookie: string } }).document = { cookie: "a=1; sk_csrf=abc%3D" };
    const client = createShopkitClient({
      baseUrl: "https://shop.test",
      fetch: async (req) => {
        seen.push(req as Request);
        return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
      },
    });
    await client.POST("/api/admin/auth/logout");
    await client.GET("/api/setup/status");
    expect(seen[0]!.headers.get("x-csrf-token")).toBe("abc=");
    expect(seen[1]!.headers.get("x-csrf-token")).toBeNull();
    delete (globalThis as { document?: unknown }).document;
  });

  it("extracts error messages and field errors", () => {
    const err = { error: { code: "validation_failed", message: "Check", details: [{ path: "config.keyId", message: "bad" }, { field: "password", message: "weak" }] } };
    expect(errorMessage(err)).toBe("Check");
    expect(errorMessage(undefined, "x")).toBe("x");
    expect(fieldErrors(err)).toEqual({ "config.keyId": "bad", password: "weak" });
    expect(fieldErrors({})).toEqual({});
  });
});
