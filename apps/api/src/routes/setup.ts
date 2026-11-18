import {
  AppError,
  analyticsStepInput,
  beginSetup,
  completeOptionalStep,
  confirmTotpEnrollment,
  createSession,
  credentialStepInput,
  emailStepInput,
  getSetupStatus,
  getWizardState,
  isValidSetupToken,
  launchStore,
  ownerInput,
  ownerStaffId,
  paymentsStepInput,
  requireSetupStore,
  saveOwnerStep,
  saveSetupCredential,
  saveShippingTaxStep,
  saveStorageStep,
  saveStoreStep,
  sendTestEmail,
  shippingTaxInput,
  startTotpEnrollment,
  storeDetailsSchema,
  testSetupCredential,
  uploadBrandAsset,
  staffView,
  getStaff,
  getStore,
  storeView,
} from "@shopkit/core";
import type { FastifyPluginAsyncZod, ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { Config } from "../config.js";
import { secureCookies } from "../config.js";
import type { AppDeps } from "../deps.js";
import { actorOf } from "../plugins/auth.js";
import { SETUP_COOKIE, setSessionCookies } from "../plugins/cookies.js";
import { requireSetupToken, setupCsrf } from "../plugins/setup-guard.js";
import {
  credentialSummary,
  errorResponses,
  okBody,
  setupStatus,
  staffView as staffViewSchema,
  storeView as storeViewSchema,
  testResult,
  totpEnrollment,
  wizardState,
} from "../schemas.js";
import { readUpload } from "./uploads.js";

const tags = ["setup"];

export const setupRoutes: FastifyPluginAsyncZod<{ deps: AppDeps; config: Config }> = async (app, { deps, config }) => {
  const secure = secureCookies(config);

  app.get("/status", { schema: { tags, operationId: "getSetupStatus", response: { 200: setupStatus } } }, () => getSetupStatus(deps));

  app.post(
    "/token",
    {
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: {
        tags,
        operationId: "verifySetupToken",
        body: z.object({ token: z.string().min(1).max(128) }),
        response: { 200: z.object({ ok: z.literal(true), csrf: z.string() }), ...errorResponses },
      },
    },
    async (req, reply) => {
      const status = await getSetupStatus(deps);
      if (!status.required) throw new AppError("setup_complete", "Setup is already complete");
      const token = req.body.token.trim();
      if (!(await isValidSetupToken(deps.redis, token))) {
        throw new AppError("unauthorized", "That setup token is not valid. Copy it again from: docker compose logs api");
      }
      await beginSetup(deps);
      const csrf = setupCsrf(config.SESSION_SECRET, token);
      reply.setCookie(SETUP_COOKIE, token, { httpOnly: true, sameSite: "strict", secure, path: "/api/setup", maxAge: 7 * 24 * 3600 });
      reply.setCookie("sk_setup_csrf", csrf, { httpOnly: false, sameSite: "strict", secure, path: "/", maxAge: 7 * 24 * 3600 });
      return { ok: true as const, csrf };
    },
  );

  // Everything below requires the setup token.
  await app.register(async (guarded) => {
    guarded.addHook("onRequest", requireSetupToken(deps, config.SESSION_SECRET));
    const g = guarded.withTypeProvider<ZodTypeProvider>();

    g.get("/state", { schema: { tags, operationId: "getSetupState", response: { 200: wizardState, ...errorResponses } } }, () =>
      getWizardState(deps),
    );

    g.put(
      "/owner",
      { schema: { tags, operationId: "saveSetupOwner", body: ownerInput, response: { 200: z.object({ staffId: z.uuid() }), ...errorResponses } } },
      (req) => saveOwnerStep(deps, actorOf(req), req.body),
    );

    g.post(
      "/owner/totp/start",
      { schema: { tags, operationId: "startSetupTotp", response: { 200: totpEnrollment, ...errorResponses } } },
      async () => {
        const storeId = await requireSetupStore(deps);
        return startTotpEnrollment(deps, storeId, await ownerStaffId(deps));
      },
    );

    g.post(
      "/owner/totp/confirm",
      { schema: { tags, operationId: "confirmSetupTotp", body: z.object({ code: z.string() }), response: { 200: okBody, ...errorResponses } } },
      async (req) => {
        const storeId = await requireSetupStore(deps);
        await confirmTotpEnrollment(deps, actorOf(req), storeId, await ownerStaffId(deps), req.body.code);
        return { ok: true as const };
      },
    );

    g.post(
      "/credentials/:kind/test",
      {
        schema: {
          tags,
          operationId: "testSetupCredential",
          params: z.object({ kind: z.enum(["storage", "payment", "email", "analytics"]) }),
          body: credentialStepInput,
          response: { 200: testResult, ...errorResponses },
        },
      },
      (req) => testSetupCredential(deps, req.params.kind, req.body),
    );

    g.put(
      "/storage",
      { schema: { tags, operationId: "saveSetupStorage", body: credentialStepInput, response: { 200: credentialSummary, ...errorResponses } } },
      (req) => saveStorageStep(deps, actorOf(req), req.body),
    );

    g.put(
      "/credentials/:kind",
      {
        schema: {
          tags,
          operationId: "saveSetupCredential",
          params: z.object({ kind: z.enum(["payment", "email", "analytics"]) }),
          body: credentialStepInput,
          response: { 200: credentialSummary, ...errorResponses },
        },
      },
      (req) => saveSetupCredential(deps, actorOf(req), req.params.kind, req.body),
    );

    g.put(
      "/store",
      { schema: { tags, operationId: "saveSetupStore", body: storeDetailsSchema, response: { 200: okBody, ...errorResponses } } },
      async (req) => {
        await saveStoreStep(deps, actorOf(req), req.body);
        return { ok: true as const };
      },
    );

    g.post(
      "/store/:asset",
      {
        schema: {
          tags,
          operationId: "uploadSetupBrandAsset",
          consumes: ["multipart/form-data"],
          params: z.object({ asset: z.enum(["logo", "favicon"]) }),
          response: { 200: z.object({ id: z.uuid(), url: z.string() }), ...errorResponses },
        },
      },
      async (req) => {
        const storeId = await requireSetupStore(deps);
        const row = await uploadBrandAsset(deps, actorOf(req), storeId, req.params.asset, await readUpload(req));
        return { id: row.id, url: `${deps.runtime.publicUrl}/media/${row.id}/${encodeURIComponent(row.filename)}` };
      },
    );

    g.post(
      "/steps/:step",
      {
        schema: {
          tags,
          operationId: "completeSetupStep",
          params: z.object({ step: z.enum(["payments", "email", "analytics"]) }),
          body: z.object({
            skip: z.boolean().default(false),
            payments: paymentsStepInput.optional(),
            email: emailStepInput.optional(),
            analytics: analyticsStepInput.optional(),
          }),
          response: { 200: okBody, ...errorResponses },
        },
      },
      async (req) => {
        const { step } = req.params;
        await completeOptionalStep(deps, step, req.body[step], req.body.skip);
        return { ok: true as const };
      },
    );

    g.put(
      "/shipping-tax",
      {
        schema: {
          tags,
          operationId: "saveSetupShippingTax",
          body: z.union([z.object({ skip: z.literal(true) }), shippingTaxInput]),
          response: { 200: okBody, ...errorResponses },
        },
      },
      async (req) => {
        const skip = "skip" in req.body;
        await saveShippingTaxStep(deps, actorOf(req), skip ? ({} as never) : (req.body as z.infer<typeof shippingTaxInput>), skip);
        return { ok: true as const };
      },
    );

    g.post(
      "/email/test-send",
      {
        config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
        schema: {
          tags,
          operationId: "sendSetupTestEmail",
          body: z.object({ provider: z.string(), mode: z.enum(["test", "live"]), to: z.email() }),
          response: { 200: testResult, ...errorResponses },
        },
      },
      async (req) => {
        const storeId = await requireSetupStore(deps);
        return sendTestEmail(deps, { storeId, provider: req.body.provider, mode: req.body.mode }, req.body.to);
      },
    );

    g.post(
      "/launch",
      {
        schema: {
          tags,
          operationId: "launchStore",
          response: { 200: z.object({ ok: z.literal(true), staff: staffViewSchema, store: storeViewSchema, csrf: z.string() }), ...errorResponses },
        },
      },
      async (req, reply) => {
        const { storeId, ownerId } = await launchStore(deps, actorOf(req));
        const { token, session } = await createSession(deps.redis, ownerId, storeId);
        setSessionCookies(reply, secure, token, session.csrf);
        reply.clearCookie(SETUP_COOKIE, { path: "/api/setup" });
        reply.clearCookie("sk_setup_csrf", { path: "/" });
        const owner = await getStaff(deps.db, storeId, ownerId);
        return {
          ok: true as const,
          staff: await staffView(deps.db, owner!),
          store: await storeView(deps, await getStore(deps.db, storeId)),
          csrf: session.csrf,
        };
      },
    );
  });
};
