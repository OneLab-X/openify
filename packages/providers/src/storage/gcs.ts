import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Storage } from "@google-cloud/storage";
import { z } from "zod";
import { errorMessage } from "../http.js";
import type { ProviderDefinition, StorageProvider } from "../types.js";
import { assertSafeKey, encodeKey, PROBE_PREFIX } from "./keys.js";
import { parseServiceAccount, serviceAccountJson } from "./service-account.js";

const configSchema = z.object({
  bucket: z.string().min(3).max(222).meta({ title: "Bucket" }),
  publicBaseUrl: z
    .url()
    .optional()
    .meta({
      title: "Public base URL",
      description: "e.g. https://storage.googleapis.com/<bucket> for a public bucket, or your CDN. Leave empty to serve files through /media.",
    }),
  apiEndpoint: z.url().optional().meta({ title: "Custom API endpoint (advanced)", description: "Only for emulators such as fake-gcs-server." }),
});
const secretsSchema = z.object({ serviceAccountJson });
type Config = z.infer<typeof configSchema>;
type Secrets = z.infer<typeof secretsSchema>;

function gcsError(err: unknown): string {
  const code = (err as { code?: unknown }).code;
  if (code === 404) return "Bucket does not exist";
  if (code === 401 || code === 403) return "Access denied: give the service account Storage Object Admin on the bucket";
  return errorMessage(err);
}

const isNotFound = (err: unknown) => (err as { code?: unknown }).code === 404;

export const gcsStorage: ProviderDefinition<"storage", Config, Secrets> = {
  id: "gcs",
  kind: "storage",
  displayName: "Google Cloud Storage",
  description: "Service account with the Storage Object Admin role on the bucket.",
  docsUrl: "https://cloud.google.com/storage/docs/access-control/iam-roles",
  modes: ["live"],
  configSchema,
  secretsSchema,
  create(ctx) {
    const account = parseServiceAccount(ctx.secrets.serviceAccountJson);
    const storage = new Storage({
      projectId: account.project_id,
      credentials: { client_email: account.client_email, private_key: account.private_key },
      ...(ctx.config.apiEndpoint ? { apiEndpoint: ctx.config.apiEndpoint } : {}),
      retryOptions: { maxRetries: 2 },
    });
    const bucket = storage.bucket(ctx.config.bucket);
    const file = (key: string) => bucket.file(assertSafeKey(key));

    const provider: StorageProvider = {
      async testCredentials() {
        const key = `${PROBE_PREFIX}/${randomUUID()}.txt`;
        try {
          await provider.put(key, Buffer.from("shopkit probe"), { contentType: "text/plain" });
          await provider.delete(key);
          return { ok: true };
        } catch (err) {
          return { ok: false, error: gcsError(err) };
        }
      },
      async put(key, body, { contentType, cacheControl }) {
        const options = { resumable: false, contentType, metadata: { contentType, ...(cacheControl ? { cacheControl } : {}) } };
        if (Buffer.isBuffer(body)) await file(key).save(body, options);
        else await pipeline(body, file(key).createWriteStream(options));
      },
      async get(key) {
        const f = file(key);
        try {
          const [meta] = await f.getMetadata();
          const size = meta.size === undefined ? undefined : Number(meta.size);
          return {
            body: f.createReadStream(),
            ...(meta.contentType ? { contentType: meta.contentType } : {}),
            ...(size !== undefined && Number.isFinite(size) ? { contentLength: size } : {}),
          };
        } catch (err) {
          if (isNotFound(err)) return null;
          throw err;
        }
      },
      async getSignedUrl(key, { expiresIn }) {
        const [url] = await file(key).getSignedUrl({ version: "v4", action: "read", expires: Date.now() + expiresIn * 1000 });
        return url;
      },
      async createUploadUrl(key, { contentType, expiresIn }) {
        const [url] = await file(key).getSignedUrl({ version: "v4", action: "write", contentType, expires: Date.now() + expiresIn * 1000 });
        return { url, method: "PUT", headers: { "content-type": contentType } };
      },
      publicUrl: (key) =>
        ctx.config.publicBaseUrl ? `${ctx.config.publicBaseUrl.replace(/\/$/, "")}/${encodeKey(assertSafeKey(key))}` : null,
      async delete(key) {
        await file(key).delete({ ignoreNotFound: true });
      },
      async *list(prefix) {
        let pageToken: string | undefined;
        do {
          const [files, next] = await bucket.getFiles({ prefix, autoPaginate: false, maxResults: 1000, ...(pageToken ? { pageToken } : {}) });
          for (const f of files) yield f.name;
          pageToken = (next as { pageToken?: string } | null)?.pageToken;
        } while (pageToken);
      },
    };
    return provider;
  },
};
