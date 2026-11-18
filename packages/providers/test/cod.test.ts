import { describe, expect, it } from "vitest";
import { cod } from "../src/payments/cod.js";
import { ProviderError, WebhookSignatureError } from "../src/types.js";
import { ctx } from "./helpers.js";

describe("cod", () => {
  const p = cod.create(ctx({ maxOrderAmount: 1000, instructions: "Keep change" }, {}, "live"));
  it("needs no credentials", async () => {
    expect(await p.testCredentials()).toMatchObject({ ok: true });
  });
  it("creates a session without a provider order, enforcing the limit", async () => {
    const s = await p.createSession({ order: { id: "o1" }, amount: 900, currency: "INR", customer: {}, returnUrl: "" });
    expect(s).toMatchObject({ providerOrderId: null, clientPayload: { provider: "cod", instructions: "Keep change" } });
    await expect(p.createSession({ order: { id: "o1" }, amount: 1001, currency: "INR", customer: {}, returnUrl: "" }))
      .rejects.toThrow(ProviderError);
  });
  it("has no return, webhook, refund or lookup", async () => {
    await expect(p.verifyReturn({})).rejects.toThrow(WebhookSignatureError);
    await expect(p.parseWebhook(Buffer.from(""), {})).rejects.toThrow(WebhookSignatureError);
    await expect(p.refund("x", 1)).rejects.toThrow(ProviderError);
    await expect(p.getPayment("x")).rejects.toThrow(ProviderError);
  });
});
