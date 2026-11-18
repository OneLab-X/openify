import { AppError } from "@shopkit/core";
import { DecryptionError } from "@shopkit/crypto";
import type { FastifyError, FastifyInstance } from "fastify";
import { hasZodFastifySchemaValidationErrors } from "fastify-type-provider-zod";
import { ZodError } from "zod";

export interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
}

const zodDetails = (err: ZodError) => err.issues.map((i) => ({ path: i.path.join("."), message: i.message }));

/** Maps domain/validation errors to a stable JSON shape; hides internals of unexpected errors. */
export function registerErrorHandler(app: FastifyInstance) {
  app.setErrorHandler((err: FastifyError | Error, req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.status).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if (err instanceof ZodError) {
      return reply.status(422).send({ error: { code: "validation_failed", message: "Check the highlighted fields", details: zodDetails(err) } });
    }
    if (hasZodFastifySchemaValidationErrors(err)) {
      return reply.status(422).send({
        error: {
          code: "validation_failed",
          message: "Check the highlighted fields",
          details: err.validation.map((v) => ({ path: v.instancePath.replace(/^\//, "").replace(/\//g, "."), message: v.message })),
        },
      });
    }
    const status = "statusCode" in err && typeof err.statusCode === "number" ? err.statusCode : 500;
    if (status === 429) return reply.status(429).send({ error: { code: "rate_limited", message: "Too many requests, slow down" } });
    if (status >= 400 && status < 500) {
      return reply.status(status).send({ error: { code: "bad_request", message: err.message } });
    }
    if (err instanceof DecryptionError) req.log.error("stored secret could not be decrypted (check SHOPKIT_MASTER_KEY)");
    else req.log.error({ err }, "unhandled error");
    return reply.status(500).send({ error: { code: "internal", message: "Something went wrong" } });
  });
  app.setNotFoundHandler((_req, reply) => reply.status(404).send({ error: { code: "not_found", message: "Not found" } }));
}
