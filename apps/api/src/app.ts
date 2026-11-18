import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { MAX_IMAGE_BYTES } from "@shopkit/core";
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import { jsonSchemaTransform, jsonSchemaTransformObject, serializerCompiler, validatorCompiler, type ZodTypeProvider } from "fastify-type-provider-zod";
import type { Config } from "./config.js";
import type { AppDeps } from "./deps.js";
import { registerErrorHandler } from "./plugins/errors.js";
import { adminRoutes } from "./routes/admin.js";
import { authRoutes } from "./routes/auth.js";
import { healthRoutes } from "./routes/health.js";
import { mediaRoutes } from "./routes/media.js";
import { setupRoutes } from "./routes/setup.js";
import { storefrontRoutes } from "./routes/storefront.js";

export interface BuildOptions {
  logger?: FastifyBaseLogger;
  /** Swagger UI is skipped in tests and when emitting the spec. */
  docsUi?: boolean;
}

export async function buildApp(deps: AppDeps, config: Config, opts: BuildOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    ...(opts.logger ? { loggerInstance: opts.logger } : { logger: false }),
    trustProxy: config.TRUST_PROXY,
    bodyLimit: 1024 * 1024,
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerErrorHandler(app);

  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: MAX_IMAGE_BYTES, files: 1, fields: 5 } });
  await app.register(rateLimit, {
    global: true,
    max: 600,
    timeWindow: "1 minute",
    redis: deps.redis,
    nameSpace: "sk:rl:",
    skipOnError: true,
    allowList: (req) => req.url === "/api/health" || req.url === "/api/ready",
  });

  await app.register(swagger, {
    openapi: {
      openapi: "3.1.0",
      info: { title: "Shopkit API", version: "0.1.0", description: "Setup, Admin and Storefront APIs" },
      servers: [{ url: "/" }],
      tags: [{ name: "setup" }, { name: "auth" }, { name: "admin" }, { name: "storefront" }],
    },
    transform: jsonSchemaTransform,
    transformObject: jsonSchemaTransformObject,
  });
  if (opts.docsUi !== false) await app.register(swaggerUi, { routePrefix: "/api/docs" });

  await app.register(healthRoutes, { prefix: "/api", deps });
  await app.register(setupRoutes, { prefix: "/api/setup", deps, config });
  await app.register(authRoutes, { prefix: "/api/admin/auth", deps, config });
  await app.register(adminRoutes, { prefix: "/api/admin", deps });
  await app.register(storefrontRoutes, { prefix: "/api/storefront", deps });
  await app.register(mediaRoutes, { deps });

  return app;
}
