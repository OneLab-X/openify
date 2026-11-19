import { hasPermission, permissionsFor, touchSession, getStaff, twoFactorSetupRequired, AppError, type Actor, type Permission, type StaffSession } from "@shopkit/core";
import { safeEqual } from "@shopkit/crypto";
import type { FastifyReply, FastifyRequest, onRequestAsyncHookHandler } from "fastify";
import type { AppDeps } from "../deps.js";
import { SESSION_COOKIE } from "./cookies.js";

declare module "fastify" {
  interface FastifyRequest {
    staff?: { id: string; storeId: string; permissions: string[]; session: StaffSession; token: string };
  }
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function actorOf(req: FastifyRequest): Actor {
  return {
    type: req.staff ? "staff" : "setup",
    id: req.staff?.id ?? null,
    ip: req.ip,
    userAgent: req.headers["user-agent"] ?? null,
  };
}

/**
 * Requires a staff session (cookie) and, for mutating requests, a matching X-CSRF-Token header.
 * When the store enforces 2FA, staff without it can only reach routes marked `allowPendingTwoFactor`
 * (who am I, TOTP enrolment, sign out) until they set it up.
 */
export function requireStaff(deps: AppDeps, permission?: Permission, opts: { allowPendingTwoFactor?: boolean } = {}): onRequestAsyncHookHandler {
  return async function (req: FastifyRequest, _reply: FastifyReply) {
    const token = req.cookies[SESSION_COOKIE];
    const session = token ? await touchSession(deps.redis, token) : null;
    if (!token || !session) throw new AppError("unauthorized", "Sign in required");
    if (!SAFE_METHODS.has(req.method)) {
      const header = req.headers["x-csrf-token"];
      if (typeof header !== "string" || !safeEqual(header, session.csrf)) {
        throw new AppError("forbidden", "Missing or invalid CSRF token");
      }
    }
    const staff = await getStaff(deps.db, session.storeId, session.staffId);
    if (!staff || staff.disabledAt) throw new AppError("unauthorized", "Sign in required");
    if (!opts.allowPendingTwoFactor && (await twoFactorSetupRequired(deps.db, staff.storeId, staff))) {
      throw new AppError("forbidden", "Set up two-factor authentication to continue", { reason: "two_factor_required" });
    }
    const permissions = await permissionsFor(deps.db, staff.roleId);
    if (permission && !hasPermission(permissions, permission)) throw new AppError("forbidden", "You do not have permission to do that");
    req.staff = { id: staff.id, storeId: staff.storeId, permissions, session, token };
  };
}
