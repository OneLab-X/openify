import { media, outboxEvents, providerCredentials, stores } from "@shopkit/db";
import { text } from "node:stream/consumers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { listCredentials } from "../src/credentials.js";
import { deliverEmail, sendTestEmail } from "../src/emails/deliver.js";
import { readMedia, sniffImage, uploadBrandAsset } from "../src/media.js";
import { dispatchOutbox, type OutboxEvent } from "../src/outbox.js";
import { routeOutboxEvent } from "../src/outbox-routes.js";
import { getSetting } from "../src/settings.js";
import { clearSetupTokens, isValidSetupToken, issueSetupToken } from "../src/setup/token.js";
import {
  beginSetup, completeOptionalStep, getSetupStatus, getWizardState, launchStore, requireSetupStore, saveOwnerStep,
  saveSetupCredential, saveShippingTaxStep, saveStorageStep, saveStoreStep, testSetupCredential,
} from "../src/setup/wizard.js";
import { ACTOR, makeDeps, sentEmails, STRONG_PASSWORD, type TestDeps } from "./harness.js";

let deps: TestDeps;
beforeAll(async () => {
  deps = await makeDeps();
});
afterAll(() => deps.close());
beforeEach(() => deps.reset());

const PNG = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex");
const storeDetails = {
  name: "Pretty Little Store", email: "hello@pls.test", country: "IN", currency: "INR", timezone: "Asia/Kolkata",
  locale: "en-IN", weightUnit: "kg" as const, publicUrl: "https://shop.test", brand: { primaryColor: "#112233" },
  address: { line1: "1 MG Road", city: "Bengaluru", country: "IN" },
};

describe("setup token", () => {
  it("is stored hashed and can be cleared", async () => {
    const token = await issueSetupToken(deps.redis);
    expect(await deps.redis.smembers("sk:setup:tokens")).not.toContain(token);
    expect(await isValidSetupToken(deps.redis, token)).toBe(true);
    expect(await isValidSetupToken(deps.redis, `${token}x`)).toBe(false);
    expect(await isValidSetupToken(deps.redis, undefined)).toBe(false);
    await clearSetupTokens(deps.redis);
    expect(await isValidSetupToken(deps.redis, token)).toBe(false);
  });
});

describe("setup wizard", () => {
  it("walks every step and launches the store", async () => {
    expect(await getSetupStatus(deps)).toEqual({ required: true, step: "token" });
    await expect(requireSetupStore(deps)).rejects.toMatchObject({ code: "setup_required" });
    const storeId = await beginSetup(deps);
    expect(await beginSetup(deps)).toBe(storeId);
    expect(await getSetupStatus(deps)).toEqual({ required: true, step: "owner" });

    await expect(saveOwnerStep(deps, ACTOR, { name: "Asha", email: "asha@pls.test", password: "password123" })).rejects.toMatchObject({ code: "validation_failed" });
    await saveOwnerStep(deps, ACTOR, { name: "Asha", email: "asha@pls.test", password: STRONG_PASSWORD });
    expect((await getSetupStatus(deps)).step).toBe("storage");

    await expect(launchStore(deps, ACTOR)).rejects.toThrow(/storage, store/);

    const bad = await testSetupCredential(deps, "storage", { provider: "s3-compatible", mode: "live",
      config: { endpoint: "http://127.0.0.1:1", bucket: "nope", region: "us-east-1" }, secrets: { accessKeyId: "abc", secretAccessKey: "abcdefghij" } });
    expect(bad.ok).toBe(false);
    await expect(saveStorageStep(deps, ACTOR, { provider: "s3-compatible", mode: "live",
      config: { endpoint: "http://127.0.0.1:1", bucket: "nope" }, secrets: { accessKeyId: "abc", secretAccessKey: "abcdefghij" } }))
      .rejects.toMatchObject({ code: "provider_error" });
    await saveStorageStep(deps, ACTOR, { provider: "local", mode: "live" });
    expect(await getSetting(deps.db, storeId, "storage.active")).toEqual({ provider: "local", mode: "live" });

    await saveStoreStep(deps, ACTOR, storeDetails);
    const logo = await uploadBrandAsset(deps, ACTOR, storeId, "logo", { filename: "logo.png", data: PNG });
    await expect(uploadBrandAsset(deps, ACTOR, storeId, "logo", { filename: "x.svg", data: Buffer.from("<svg/>") })).rejects.toThrow(/PNG/);

    await saveSetupCredential(deps, ACTOR, "payment", { provider: "cod", mode: "live", config: { instructions: "Pay cash" } });
    await completeOptionalStep(deps, "payments", { mode: "test" }, false);
    await saveSetupCredential(deps, ACTOR, "email", { provider: "memory", mode: "live", config: { fromEmail: "shop@pls.test" }, secrets: { apiKey: "mem_key_12345" } });
    await expect(completeOptionalStep(deps, "email", { provider: "resend", mode: "live" }, false)).rejects.toThrow(/Save the email provider/);
    await completeOptionalStep(deps, "email", { provider: "memory", mode: "live" }, false);
    expect(await sendTestEmail(deps, { storeId, provider: "memory", mode: "live" }, "asha@pls.test")).toMatchObject({ ok: true });
    expect(sentEmails.at(-1)!.subject).toBe("Test email from Pretty Little Store");
    await completeOptionalStep(deps, "analytics", {}, true);
    await saveShippingTaxStep(deps, ACTOR, {
      shipFrom: { name: "Warehouse", address: { city: "Bengaluru", country: "in" } },
      zone: { name: "India", countries: ["in"] }, rate: { name: "Standard", amount: 5000, freeOver: 99900 },
      tax: { mode: "india_gst", gstin: "29ABCDE1234F1Z5" },
    });
    expect(await getSetting(deps.db, storeId, "tax.config")).toMatchObject({ mode: "india_gst", pricesIncludeTax: true, defaultRateBps: 1800 });

    const state = await getWizardState(deps);
    expect(state.currentStep).toBe("review");
    expect(state.store.logoUrl).toBe(`https://shop.test/media/${logo.id}/logo.png`);
    expect(state.owner).toMatchObject({ email: "asha@pls.test" });
    expect(state.providers.some((p) => p.id === "stripe" && p.status === "coming_soon")).toBe(true);
    expect(JSON.stringify(state)).not.toContain("mem_key_12345");

    await issueSetupToken(deps.redis);
    const launched = await launchStore(deps, ACTOR);
    expect(launched.storeId).toBe(storeId);
    expect(await getSetupStatus(deps)).toEqual({ required: false, step: "review" });
    expect(await deps.redis.exists("sk:setup:tokens")).toBe(0);
    await expect(saveStoreStep(deps, ACTOR, storeDetails)).rejects.toMatchObject({ code: "setup_complete", status: 410 });
    await expect(beginSetup(deps)).rejects.toMatchObject({ code: "setup_complete" });

    // Side effects flow through the outbox: launch email + logo processing.
    const routed: string[] = [];
    await dispatchOutbox(deps.db, async (events: OutboxEvent[]) => {
      for (const e of events) for (const job of await routeOutboxEvent(deps, e)) {
        routed.push(`${job.queue}:${job.name}`);
        if (job.queue === "email") {
          const r = await deliverEmail(deps, job.data as never);
          expect(r.status).toBe("sent");
          expect((await deliverEmail(deps, job.data as never)).status).toBe("skipped");
        }
      }
    });
    expect(routed.sort()).toEqual(["email:store-launched", "images:process"]);
    expect(sentEmails.at(-1)).toMatchObject({ to: "asha@pls.test", subject: "Pretty Little Store is live" });
    expect(await deps.db.$count(outboxEvents)).toBe(2);

    const read = await readMedia(deps, logo.id);
    expect(read && "object" in read && (await text(read.object.body))).toBeTruthy();
    expect(await readMedia(deps, "00000000-0000-7000-8000-000000000000")).toBeNull();
    expect((await listCredentials(deps, storeId)).length).toBe(3);
    expect(await deps.db.$count(providerCredentials)).toBe(3);
    expect(await deps.db.$count(media)).toBe(1);
    expect((await deps.db.select().from(stores))[0]!.status).toBe("active");
  });

  it("skipped email means launch emails are skipped, not failed", async () => {
    const storeId = await beginSetup(deps);
    expect(await deliverEmail(deps, { storeId, template: "test", to: "a@b.co", data: {}, idempotencyKey: "k" }))
      .toEqual({ status: "skipped", reason: "no email provider" });
  });

  it("sniffs image types", () => {
    expect(sniffImage(PNG)).toEqual({ contentType: "image/png", ext: "png" });
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))?.ext).toBe("jpg");
    expect(sniffImage(Buffer.from("RIFF0000WEBP"))?.ext).toBe("webp");
    expect(sniffImage(Buffer.from("GIF89a"))?.ext).toBe("gif");
    expect(sniffImage(Buffer.from([0, 0, 1, 0]))?.ext).toBe("ico");
    expect(sniffImage(Buffer.from("<svg"))).toBeNull();
  });
});
