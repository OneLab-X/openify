import { AppError, getInstallStore, isValidSetupToken } from "@shopkit/core";
import { hmacSha256Hex, safeEqual } from "@shopkit/crypto";
import type { FastifyRequest, onRequestAsyncHookHandler } from "fastify";
import type { AppDeps } from "../deps.js";
import { SETUP_COOKIE } from "./cookies.js";

/** CSRF value bound to the setup token: HMAC(SESSION_SECRET, token). No server state needed. */
export const setupCsrf = (secret: string, token: string) => hmacSha256Hex(secret, `setup-csrf:${token}`);

function presentedToken(req: FastifyRequest): { token: string | undefined; viaCookie: boolean } {
  const header = req.headers["x-setup-token"];
  if (typeof header === "string" && header) return { token: header.trim(), viaCookie: false };
  return { token: req.cookies[SETUP_COOKIE], viaCookie: true };
}

/**
 * Guards /api/setup/* (SPEC §5): rejected once a store is active (410) and otherwise requires a
 * valid setup token, either as X-Setup-Token or as the httpOnly cookie set after the token step.
 * Cookie-authenticated writes also need X-CSRF-Token.
 */
export function requireSetupToken(deps: AppDeps, sessionSecret: string): onRequestAsyncHookHandler {
  return async function (req) {
    const store = await getInstallStore(deps.db);
    if (store?.status === "active") throw new AppError("setup_complete", "Setup is already complete");
    const { token, viaCookie } = presentedToken(req);
    if (!(await isValidSetupToken(deps.redis, token))) {
      throw new AppError("unauthorized", "A valid setup token is required. Find it with: docker compose logs api");
    }
    if (viaCookie && req.method !== "GET") {
      const header = req.headers["x-csrf-token"];
      if (typeof header !== "string" || !safeEqual(header, setupCsrf(sessionSecret, token!))) {
        throw new AppError("forbidden", "Missing or invalid CSRF token");
      }
    }
  };
}
