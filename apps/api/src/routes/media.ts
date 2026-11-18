import { readMedia } from "@shopkit/core";
import { UUID_RE } from "@shopkit/db";
import type { FastifyPluginAsync } from "fastify";
import type { AppDeps } from "../deps.js";

/** /media/:id/:filename — streams public media from providers without a public URL (SPEC §4). */
export const mediaRoutes: FastifyPluginAsync<{ deps: AppDeps }> = async (app, { deps }) => {
  app.get<{ Params: { id: string; filename: string } }>("/media/:id/:filename", { schema: { hide: true } }, async (req, reply) => {
    if (!UUID_RE.test(req.params.id)) return reply.status(404).send({ error: { code: "not_found", message: "Not found" } });
    const result = await readMedia(deps, req.params.id);
    if (!result) return reply.status(404).send({ error: { code: "not_found", message: "Not found" } });
    if ("redirect" in result) return reply.redirect(result.redirect, 302);
    reply
      .header("content-type", result.contentType)
      .header("cache-control", "public, max-age=31536000, immutable")
      .header("x-content-type-options", "nosniff")
      .header("content-security-policy", "default-src 'none'; sandbox");
    if (result.object.contentLength !== undefined) reply.header("content-length", result.object.contentLength);
    return reply.send(result.object.body);
  });
};
