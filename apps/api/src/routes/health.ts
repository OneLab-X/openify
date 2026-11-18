import { sql } from "@shopkit/db";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { AppDeps } from "../deps.js";

export const healthRoutes: FastifyPluginAsyncZod<{ deps: AppDeps }> = async (app, { deps }) => {
  app.get("/health", { schema: { hide: true, response: { 200: z.object({ ok: z.literal(true) }) } } }, async () => ({ ok: true as const }));

  app.get(
    "/ready",
    { schema: { hide: true, response: { 200: z.object({ ok: z.boolean() }), 503: z.object({ ok: z.boolean() }) } } },
    async (_req, reply) => {
      try {
        await deps.db.execute(sql`select 1`);
        await deps.redis.ping();
        return { ok: true };
      } catch {
        return reply.status(503).send({ ok: false });
      }
    },
  );
};
