import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { buffer as readAll } from "node:stream/consumers";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { JWT } from "google-auth-library";
import { z } from "zod";
import { errorMessage, request } from "../http.js";
import { ProviderError, type ProviderDefinition, type StorageProvider } from "../types.js";
import { assertSafeKey, PROBE_PREFIX } from "./keys.js";
import { parseServiceAccount, serviceAccountJson } from "./service-account.js";
import { signProxyUrl } from "./sign.js";

export const DRIVE_API = "https://www.googleapis.com";

const configSchema = z.object({
  folderId: z
    .string()
    .regex(/^[A-Za-z0-9_-]{10,}$/, "The folder ID from the folder's URL (…/folders/<id>)")
    .meta({ title: "Folder ID", description: "Share this folder with the service account's email as Editor." }),
});
const secretsSchema = z.object({ serviceAccountJson });
type Config = z.infer<typeof configSchema>;
type Secrets = z.infer<typeof secretsSchema>;

interface DriveFile {
  id: string;
  name: string;
  mimeType?: string;
  size?: string;
}

/** Drive query string literal: backslash and single quote are escaped. */
const literal = (v: string) => `'${v.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

/**
 * Google Drive has no paths or signed URLs: each object key is the file name inside one folder, and
 * files are always served through the signed /media proxy (publicUrl → null).
 */
export const googleDriveStorage: ProviderDefinition<"storage", Config, Secrets> = {
  id: "google-drive",
  kind: "storage",
  displayName: "Google Drive",
  description: "Files go into one Drive folder shared with a service account. Served through /media.",
  docsUrl: "https://developers.google.com/workspace/drive/api/guides/about-auth",
  modes: ["live"],
  configSchema,
  secretsSchema,
  create(ctx) {
    const account = parseServiceAccount(ctx.secrets.serviceAccountJson);
    const auth = new JWT({ email: account.client_email, key: account.private_key, scopes: ["https://www.googleapis.com/auth/drive"] });
    const folder = ctx.config.folderId;
    const ids = new Map<string, string>();

    async function call(path: string, init: RequestInit = {}): Promise<Response> {
      const { token } = await auth.getAccessToken();
      if (!token) throw new ProviderError("Google did not return an access token");
      const res = await request(`${DRIVE_API}${path}`, {
        ...init,
        headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${token}` },
        timeoutMs: 60_000,
      });
      if (res.ok || res.status === 404) return res;
      const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
      if (res.status === 401 || res.status === 403) {
        throw new ProviderError(`Access denied: share the folder with ${account.client_email} as Editor (${body.error?.message ?? res.status})`, res.status);
      }
      throw new ProviderError(`Google Drive error ${res.status}: ${body.error?.message ?? res.statusText}`, res.status);
    }

    async function find(key: string): Promise<DriveFile | null> {
      const q = `name = ${literal(key)} and ${literal(folder)} in parents and trashed = false`;
      const params = new URLSearchParams({ q, fields: "files(id,name,mimeType,size)", supportsAllDrives: "true", includeItemsFromAllDrives: "true", pageSize: "2" });
      const res = await call(`/drive/v3/files?${params}`);
      const { files = [] } = (await res.json()) as { files?: DriveFile[] };
      const file = files[0] ?? null;
      if (file) ids.set(key, file.id);
      else ids.delete(key);
      return file;
    }

    const provider: StorageProvider = {
      async testCredentials() {
        const key = `${PROBE_PREFIX}/${randomUUID()}.txt`;
        try {
          const res = await call(`/drive/v3/files/${encodeURIComponent(folder)}?fields=id,mimeType&supportsAllDrives=true`);
          if (res.status === 404) return { ok: false, error: `Folder not found: share it with ${account.client_email}` };
          await provider.put(key, Buffer.from("shopkit probe"), { contentType: "text/plain" });
          await provider.delete(key);
          return { ok: true };
        } catch (err) {
          return { ok: false, error: errorMessage(err) };
        }
      },
      async put(key, body, { contentType }) {
        assertSafeKey(key);
        const data = Buffer.isBuffer(body) ? body : await readAll(body);
        const existing = ids.has(key) ? { id: ids.get(key)! } : await find(key);
        if (existing) {
          const res = await call(`/upload/drive/v3/files/${existing.id}?uploadType=media&supportsAllDrives=true`, {
            method: "PATCH",
            headers: { "content-type": contentType },
            body: new Uint8Array(data),
          });
          if (res.status !== 404) return;
          ids.delete(key);
        }
        const boundary = `shopkit${randomUUID().replace(/-/g, "")}`;
        const meta = JSON.stringify({ name: key, parents: [folder], mimeType: contentType });
        const multipart = Buffer.concat([
          Buffer.from(`--${boundary}\r\ncontent-type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\ncontent-type: ${contentType}\r\n\r\n`),
          data,
          Buffer.from(`\r\n--${boundary}--`),
        ]);
        const res = await call(`/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true&fields=id`, {
          method: "POST",
          headers: { "content-type": `multipart/related; boundary=${boundary}` },
          body: new Uint8Array(multipart),
        });
        const created = (await res.json()) as { id: string };
        ids.set(key, created.id);
      },
      async get(key) {
        assertSafeKey(key);
        const file = await find(key);
        if (!file) return null;
        const res = await call(`/drive/v3/files/${file.id}?alt=media&supportsAllDrives=true`);
        if (res.status === 404 || !res.body) return null;
        const length = Number(res.headers.get("content-length") ?? file.size);
        return {
          body: Readable.fromWeb(res.body as WebReadableStream<Uint8Array>),
          ...(file.mimeType ? { contentType: file.mimeType } : {}),
          ...(Number.isFinite(length) ? { contentLength: length } : {}),
        };
      },
      getSignedUrl: async (key, { expiresIn }) => signProxyUrl(ctx.runtime, ctx.storeId, "google-drive", key, expiresIn),
      publicUrl: () => null,
      async delete(key) {
        assertSafeKey(key);
        const file = await find(key);
        if (!file) return;
        await call(`/drive/v3/files/${file.id}?supportsAllDrives=true`, { method: "DELETE" });
        ids.delete(key);
      },
      async *list(prefix) {
        let pageToken: string | undefined;
        do {
          const params = new URLSearchParams({
            q: `${literal(folder)} in parents and trashed = false`,
            fields: "nextPageToken, files(id,name)",
            pageSize: "1000",
            supportsAllDrives: "true",
            includeItemsFromAllDrives: "true",
            ...(pageToken ? { pageToken } : {}),
          });
          const res = await call(`/drive/v3/files?${params}`);
          const page = (await res.json()) as { files?: DriveFile[]; nextPageToken?: string };
          for (const f of page.files ?? []) if (f.name.startsWith(prefix)) yield f.name;
          pageToken = page.nextPageToken;
        } while (pageToken);
      },
    };
    return provider;
  },
};
