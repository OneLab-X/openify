import type { CookieSerializeOptions } from "@fastify/cookie";
import type { FastifyReply } from "fastify";
import { SESSION_IDLE_SECONDS } from "@shopkit/core";

export const SESSION_COOKIE = "sk_session";
export const CSRF_COOKIE = "sk_csrf";
export const SETUP_COOKIE = "sk_setup";

export function sessionCookieOptions(secure: boolean): CookieSerializeOptions {
  return { httpOnly: true, sameSite: "lax", secure, path: "/", maxAge: SESSION_IDLE_SECONDS };
}

/** CSRF token cookie: readable by the admin JS so it can echo it in X-CSRF-Token. */
export function csrfCookieOptions(secure: boolean): CookieSerializeOptions {
  return { httpOnly: false, sameSite: "lax", secure, path: "/", maxAge: SESSION_IDLE_SECONDS };
}

export function setSessionCookies(reply: FastifyReply, secure: boolean, token: string, csrf: string) {
  reply.setCookie(SESSION_COOKIE, token, sessionCookieOptions(secure));
  reply.setCookie(CSRF_COOKIE, csrf, csrfCookieOptions(secure));
}

export function clearSessionCookies(reply: FastifyReply) {
  reply.clearCookie(SESSION_COOKIE, { path: "/" });
  reply.clearCookie(CSRF_COOKIE, { path: "/" });
}
