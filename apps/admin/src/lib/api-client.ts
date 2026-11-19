"use client";
import { createShopkitClient, type paths } from "@shopkit/sdk";

/** Browser SDK client: same-origin /api, echoes the CSRF cookie on writes. */
export const api = createShopkitClient({ baseUrl: "" });
export { errorMessage, fieldErrors } from "@shopkit/sdk";

function csrfCookie(): string | undefined {
  const pick = (name: string) => document.cookie.split("; ").find((c) => c.startsWith(`${name}=`))?.slice(name.length + 1);
  const v = pick("sk_csrf") ?? pick("sk_setup_csrf");
  return v ? decodeURIComponent(v) : undefined;
}

/** Multipart upload with the CSRF header (openapi-fetch is JSON-first). */
export async function uploadFile(url: string, file: File): Promise<{ data?: { id: string; url: string }; error?: unknown }> {
  const form = new FormData();
  form.append("file", file);
  const token = csrfCookie();
  const res = await fetch(url, { method: "POST", body: form, credentials: "include", headers: token ? { "x-csrf-token": token } : {} });
  const json: unknown = await res.json().catch(() => ({}));
  return res.ok ? { data: json as { id: string; url: string } } : { error: json };
}

/** JSON request body of an operation, e.g. `JsonBody<"/api/admin/products", "post">`. */
export type JsonBody<P extends keyof paths, M extends "post" | "put" | "patch"> = paths[P][M] extends { requestBody?: { content: { "application/json": infer B } } } ? B : never;
