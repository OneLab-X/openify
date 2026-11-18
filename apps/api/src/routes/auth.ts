import {
  AppError,
  confirmTotpEnrollment,
  destroySession,
  disableTotp,
  getInstallStore,
  getStaff,
  getStore,
  login,
  loginInput,
  loginTotp,
  staffView,
  startTotpEnrollment,
  storeView,
  totpCodeInput,
  type LoginResult,
} from "@shopkit/core";
import type { FastifyReply } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { secureCookies, type Config } from "../config.js";
import type { AppDeps } from "../deps.js";
import { actorOf, requireStaff } from "../plugins/auth.js";
import { clearSessionCookies, SESSION_COOKIE, setSessionCookies } from "../plugins/cookies.js";
import { errorResponses, loginResponse, meResponse, okBody, totpEnrollment } from "../schemas.js";

const tags = ["auth"];

export const authRoutes: FastifyPluginAsyncZod<{ deps: AppDeps; config: Config }> = async (app, { deps, config }) => {
  const secure = secureCookies(config);

  async function activeStoreId() {
    const store = await getInstallStore(deps.db);
    if (!store || store.status !== "active") throw new AppError("setup_required", "Finish setup first");
    return store.id;
  }

  function respond(reply: FastifyReply, result: LoginResult) {
    if (result.status === "totp_required") return result;
    setSessionCookies(reply, secure, result.token, result.csrf);
    return { status: "ok" as const, staff: result.staff, csrf: result.csrf };
  }

  // Login rate limit per IP on top of the per-account lockout in core.
  const loginLimit = { rateLimit: { max: 10, timeWindow: "1 minute" } };

  app.post(
    "/login",
    { config: loginLimit, schema: { tags, operationId: "login", body: loginInput, response: { 200: loginResponse, ...errorResponses } } },
    async (req, reply) => respond(reply, await login(deps, await activeStoreId(), req.body, actorOf(req))),
  );

  app.post(
    "/login/totp",
    {
      config: loginLimit,
      schema: {
        tags,
        operationId: "loginTotp",
        body: z.object({ challenge: z.string().min(1).max(200), code: z.string() }),
        response: { 200: loginResponse, ...errorResponses },
      },
    },
    async (req, reply) =>
      respond(reply, await loginTotp(deps, await activeStoreId(), req.body.challenge, req.body.code, actorOf(req))),
  );

  app.post("/logout", { schema: { tags, operationId: "logout", response: { 200: okBody } } }, async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) await destroySession(deps.redis, token);
    clearSessionCookies(reply);
    return { ok: true as const };
  });

  app.get(
    "/me",
    { onRequest: requireStaff(deps), schema: { tags, operationId: "me", response: { 200: meResponse, ...errorResponses } } },
    async (req) => {
      const s = req.staff!;
      const staff = await getStaff(deps.db, s.storeId, s.id);
      return {
        staff: await staffView(deps.db, staff!),
        store: await storeView(deps, await getStore(deps.db, s.storeId)),
        csrf: s.session.csrf,
        permissions: s.permissions as never,
      };
    },
  );

  app.post(
    "/totp/start",
    { onRequest: requireStaff(deps), schema: { tags, operationId: "startTotp", response: { 200: totpEnrollment, ...errorResponses } } },
    (req) => startTotpEnrollment(deps, req.staff!.storeId, req.staff!.id),
  );

  app.post(
    "/totp/confirm",
    { onRequest: requireStaff(deps), schema: { tags, operationId: "confirmTotp", body: totpCodeInput, response: { 200: okBody, ...errorResponses } } },
    async (req) => {
      await confirmTotpEnrollment(deps, actorOf(req), req.staff!.storeId, req.staff!.id, req.body.code);
      return { ok: true as const };
    },
  );

  app.post(
    "/totp/disable",
    {
      onRequest: requireStaff(deps),
      schema: { tags, operationId: "disableTotp", body: z.object({ password: z.string().min(1) }), response: { 200: okBody, ...errorResponses } },
    },
    async (req) => {
      await disableTotp(deps, actorOf(req), req.staff!.storeId, req.staff!.id, req.body.password, req.staff!.token);
      return { ok: true as const };
    },
  );
};
