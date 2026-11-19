import { AppError, getInstallStore, handlePaymentWebhook, handleShippingWebhook } from "@shopkit/core";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { AppDeps } from "../deps.js";
import { errorResponses } from "../schemas.js";

/**
 * POST /api/webhooks/payments/:provider (SPEC §7 step 4). Bodies are kept as raw bytes in this
 * plugin only, because signatures are computed over the exact payload the provider sent.
 */
export const webhookRoutes: FastifyPluginAsyncZod<{ deps: AppDeps }> = async (app, { deps }) => {
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", { parseAs: "buffer", bodyLimit: 1024 * 1024 }, (_req, body, done) => done(null, body));

  app.post(
    "/payments/:provider",
    {
      config: { rateLimit: { max: 300, timeWindow: "1 minute" } },
      schema: {
        tags: ["webhooks"],
        operationId: "paymentWebhook",
        params: z.object({ provider: z.string().regex(/^[a-z0-9-]{1,40}$/) }),
        response: { 200: z.object({ ok: z.literal(true), outcome: z.string() }), ...errorResponses },
      },
    },
    async (req) => {
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const { outcome } = await handlePaymentWebhook(deps, req.params.provider, raw, req.headers);
      return { ok: true as const, outcome };
    },
  );

  /** Carrier tracking updates (Shiprocket, Delhivery, EasyPost): verified by the adapter, deduped by event id. */
  app.post(
    "/shipping/:provider",
    {
      config: { rateLimit: { max: 600, timeWindow: "1 minute" } },
      schema: {
        tags: ["webhooks"],
        operationId: "shippingWebhook",
        params: z.object({ provider: z.string().regex(/^[a-z0-9-]{1,40}$/) }),
        response: { 200: z.object({ ok: z.literal(true), received: z.number().int(), applied: z.number().int() }), ...errorResponses },
      },
    },
    async (req) => {
      if (!deps.registry.get("shipping", req.params.provider)) throw new AppError("not_found", "Unknown shipping provider");
      const store = await getInstallStore(deps.db);
      if (!store) throw new AppError("not_found", "Unknown shop");
      const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const result = await handleShippingWebhook(deps, store.id, req.params.provider, raw, req.headers);
      return { ok: true as const, ...result };
    },
  );
};
