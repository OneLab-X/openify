import { readMedia, readSignedObject } from "@shopkit/core";
import { UUID_RE } from "@shopkit/db";
import { assertSafeKey, verifyProxySignature, type StoredObject } from "@shopkit/providers";
import type { FastifyPluginAsync, FastifyReply } from "fastify";
import type { AppDeps } from "../deps.js";

const notFound = (reply: FastifyReply) => reply.status(404).send({ error: { code: "not_found", message: "Not found" } });

function stream(reply: FastifyReply, object: StoredObject, contentType: string, cacheControl: string) {
  reply
    .header("content-type", contentType)
    .header("cache-control", cacheControl)
    .header("x-content-type-options", "nosniff")
    .header("content-security-policy", "default-src 'none'; sandbox");
  if (object.contentLength !== undefined) reply.header("content-length", object.contentLength);
  return reply.send(object.body);
}

/**
 * /media/:id/:file — public media (originals and `w<width>.<webp|avif>` renditions) for providers
 * without a public URL; redirects when the provider has one (SPEC §4).
 * /media/s/:store/:provider/<key>?exp&sig — short-lived signed reads (private objects, Google Drive).
 */
export const mediaRoutes: FastifyPluginAsync<{ deps: AppDeps }> = async (app, { deps }) => {
  app.get<{ Params: { id: string; filename: string } }>("/media/:id/:filename", { schema: { hide: true } }, async (req, reply) => {
    if (!UUID_RE.test(req.params.id)) return notFound(reply);
    const result = await readMedia(deps, req.params.id, req.params.filename);
    if (!result) return notFound(reply);
    if ("redirect" in result) return reply.header("cache-control", "public, max-age=3600").redirect(result.redirect, 302);
    return stream(reply, result.object, result.contentType, "public, max-age=31536000, immutable");
  });

  app.get<{ Params: { storeId: string; provider: string; "*": string }; Querystring: { exp?: string; sig?: string } }>(
    "/media/s/:storeId/:provider/*",
    { schema: { hide: true } },
    async (req, reply) => {
      const { storeId, provider } = req.params;
      const key = req.params["*"];
      const exp = Number(req.query.exp);
      if (!UUID_RE.test(storeId) || !/^[a-z0-9-]{1,64}$/.test(provider)) return notFound(reply);
      try {
        assertSafeKey(key);
      } catch {
        return notFound(reply);
      }
      if (!verifyProxySignature(deps.runtime.signingSecret, storeId, provider, key, exp, req.query.sig ?? "")) {
        return reply.status(403).send({ error: { code: "forbidden", message: "Link expired or invalid" } });
      }
      const object = await readSignedObject(deps, storeId, provider, key);
      if (!object) return notFound(reply);
      return stream(reply, object, object.contentType ?? "application/octet-stream", "private, max-age=60");
    },
  );
};
