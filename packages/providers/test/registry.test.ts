import { describe, expect, it } from "vitest";
import { createDefaultRegistry, COMING_SOON } from "../src/default-registry.js";
import { ProviderRegistry, UnknownProviderError } from "../src/registry.js";
import { cod } from "../src/payments/cod.js";

describe("ProviderRegistry", () => {
  const reg = createDefaultRegistry();

  it("registers the phase-1 providers", () => {
    expect(reg.definitions().map((d) => `${d.kind}:${d.id}`).sort()).toEqual([
      "analytics:ga4", "analytics:plausible", "email:resend", "email:smtp", "payment:cod", "payment:razorpay",
      "storage:local", "storage:s3", "storage:s3-compatible",
    ]);
  });

  it("describes forms as JSON Schema generated from zod, with metadata", () => {
    const rzp = reg.describe("payment").find((d) => d.id === "razorpay")!;
    expect(rzp.status).toBe("available");
    expect(rzp.configSchema).toMatchObject({ type: "object", properties: { keyId: { type: "string", title: "Key ID" } } });
    expect(rzp.secretsSchema).toMatchObject({ required: ["keySecret"] });
    expect(rzp.webhookEvents).toContain("payment.captured");
    const smtp = reg.describe("email").find((d) => d.id === "smtp")!;
    expect(smtp.configSchema).toMatchObject({ properties: { port: { type: "integer", default: 587 } } });
  });

  it("lists coming-soon providers without schemas", () => {
    const all = reg.describe();
    const soon = all.filter((d) => d.status === "coming_soon");
    expect(soon).toHaveLength(COMING_SOON.length);
    expect(soon.every((d) => d.configSchema === null)).toBe(true);
  });

  it("get/require/duplicate handling", () => {
    expect(reg.get("payment", "cod")).toBe(cod);
    expect(reg.get("payment", "stripe")).toBeUndefined();
    expect(() => reg.require("payment", "stripe")).toThrow(UnknownProviderError);
    expect(() => reg.register(cod)).toThrow(/already registered/);
    expect(() => new ProviderRegistry().register({ ...cod, modes: [] })).toThrow(/at least one mode/);
  });

  it("a registered provider replaces its coming-soon entry", () => {
    const r = new ProviderRegistry().registerComingSoon({ kind: "payment", id: "cod", displayName: "COD" }).register(cod);
    expect(r.describe()).toHaveLength(1);
    r.registerComingSoon({ kind: "payment", id: "cod", displayName: "COD" });
    expect(r.describe()).toHaveLength(1);
  });
});
