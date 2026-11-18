import createClient, { type Middleware } from "openapi-fetch";
import type { components, paths } from "./schema.js";

export type { paths, components };
export type Schemas = components["schemas"];

const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function readCookie(name: string): string | undefined {
  if (typeof document === "undefined") return undefined;
  const match = document.cookie.split("; ").find((c) => c.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : undefined;
}

export interface ClientOptions {
  /** Origin of the API, e.g. "" in the browser (same origin) or "http://api:4000" on the server. */
  baseUrl?: string;
  /** Extra headers, e.g. the incoming request's cookie when calling from a Next.js server component. */
  headers?: Record<string, string>;
  fetch?: typeof globalThis.fetch;
}

/**
 * Typed client for the Shopkit API (generated from OpenAPI). In the browser it echoes the CSRF
 * cookie (sk_csrf for staff sessions, sk_setup_csrf during setup) as X-CSRF-Token on writes.
 */
export function createShopkitClient(opts: ClientOptions = {}) {
  const client = createClient<paths>({
    baseUrl: opts.baseUrl ?? "",
    credentials: "include",
    ...(opts.headers ? { headers: opts.headers } : {}),
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  });
  const csrf: Middleware = {
    onRequest({ request }) {
      if (!UNSAFE.has(request.method) || request.headers.has("x-csrf-token")) return request;
      const token = readCookie("sk_csrf") ?? readCookie("sk_setup_csrf");
      if (token) request.headers.set("x-csrf-token", token);
      return request;
    },
  };
  client.use(csrf);
  return client;
}
export type ShopkitClient = ReturnType<typeof createShopkitClient>;

/** Error body shared by every endpoint. */
export type ApiError = Schemas["Error"];

export function errorMessage(error: unknown, fallback = "Something went wrong"): string {
  if (error && typeof error === "object" && "error" in error) {
    const inner = (error as { error?: { message?: unknown } }).error;
    if (inner && typeof inner.message === "string") return inner.message;
  }
  return fallback;
}

export function fieldErrors(error: unknown): Record<string, string> {
  const details = (error as { error?: { details?: unknown } } | undefined)?.error?.details;
  if (!Array.isArray(details)) return {};
  const out: Record<string, string> = {};
  for (const d of details as { path?: unknown; message?: unknown; field?: unknown }[]) {
    const key = typeof d.path === "string" ? d.path : typeof d.field === "string" ? d.field : "";
    if (key && typeof d.message === "string" && !out[key]) out[key] = d.message;
  }
  return out;
}
