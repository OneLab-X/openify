import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import {
  BlobSASPermissions,
  BlobServiceClient,
  generateBlobSASQueryParameters,
  StorageSharedKeyCredential,
} from "@azure/storage-blob";
import { z } from "zod";
import { errorMessage } from "../http.js";
import type { ProviderDefinition, StorageProvider } from "../types.js";
import { assertSafeKey, encodeKey, PROBE_PREFIX } from "./keys.js";

const configSchema = z.object({
  accountName: z
    .string()
    .regex(/^[a-z0-9]{3,24}$/, "3–24 lowercase letters and digits")
    .meta({ title: "Storage account name" }),
  container: z
    .string()
    .regex(/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/, "3–63 lowercase letters, digits and hyphens")
    .meta({ title: "Container" }),
  publicBaseUrl: z
    .url()
    .optional()
    .meta({
      title: "Public base URL",
      description: "e.g. https://<account>.blob.core.windows.net/<container> for a public container, or your CDN. Leave empty to serve files through /media.",
    }),
  endpoint: z
    .url()
    .optional()
    .meta({ title: "Custom blob endpoint (advanced)", description: "Only for Azurite or sovereign clouds, e.g. http://azurite:10000/devstoreaccount1" }),
});
const secretsSchema = z.object({
  accountKey: z.string().min(20).meta({ title: "Account key", description: "Storage account → Access keys" }),
});
type Config = z.infer<typeof configSchema>;
type Secrets = z.infer<typeof secretsSchema>;

const statusOf = (err: unknown) => (err as { statusCode?: number }).statusCode;

function azureError(err: unknown): string {
  const status = statusOf(err);
  const code = (err as { code?: string }).code;
  if (code === "ContainerNotFound" || status === 404) return "Container does not exist";
  if (status === 403 || code === "AuthenticationFailed") return "Access denied: check the account name and key";
  return errorMessage(err);
}

export const azureBlobStorage: ProviderDefinition<"storage", Config, Secrets> = {
  id: "azure-blob",
  kind: "storage",
  displayName: "Azure Blob Storage",
  docsUrl: "https://learn.microsoft.com/azure/storage/common/storage-account-keys-manage",
  modes: ["live"],
  configSchema,
  secretsSchema,
  last4Field: "accountKey",
  create(ctx) {
    const credential = new StorageSharedKeyCredential(ctx.config.accountName, ctx.secrets.accountKey);
    const endpoint = (ctx.config.endpoint ?? `https://${ctx.config.accountName}.blob.core.windows.net`).replace(/\/$/, "");
    const service = new BlobServiceClient(endpoint, credential, { retryOptions: { maxTries: 2 } });
    const container = service.getContainerClient(ctx.config.container);
    const blob = (key: string) => container.getBlockBlobClient(assertSafeKey(key));

    function sasUrl(key: string, permissions: string, expiresIn: number, contentType?: string) {
      const client = blob(key);
      const sas = generateBlobSASQueryParameters(
        {
          containerName: ctx.config.container,
          blobName: key,
          permissions: BlobSASPermissions.parse(permissions),
          startsOn: new Date(Date.now() - 60_000),
          expiresOn: new Date(Date.now() + expiresIn * 1000),
          ...(contentType ? { contentType } : {}),
        },
        credential,
      ).toString();
      return `${client.url}?${sas}`;
    }

    const provider: StorageProvider = {
      async testCredentials() {
        const key = `${PROBE_PREFIX}/${randomUUID()}.txt`;
        try {
          await provider.put(key, Buffer.from("shopkit probe"), { contentType: "text/plain" });
          await provider.delete(key);
          return { ok: true };
        } catch (err) {
          return { ok: false, error: azureError(err) };
        }
      },
      async put(key, body, { contentType, cacheControl }) {
        const blobHTTPHeaders = { blobContentType: contentType, ...(cacheControl ? { blobCacheControl: cacheControl } : {}) };
        if (Buffer.isBuffer(body)) await blob(key).uploadData(body, { blobHTTPHeaders });
        else await blob(key).uploadStream(body, 4 * 1024 * 1024, 4, { blobHTTPHeaders });
      },
      async get(key) {
        try {
          const res = await blob(key).download();
          if (!res.readableStreamBody) return null;
          return {
            body: res.readableStreamBody as Readable,
            ...(res.contentType ? { contentType: res.contentType } : {}),
            ...(res.contentLength !== undefined ? { contentLength: res.contentLength } : {}),
          };
        } catch (err) {
          if (statusOf(err) === 404) return null;
          throw err;
        }
      },
      getSignedUrl: async (key, { expiresIn }) => sasUrl(key, "r", expiresIn),
      async createUploadUrl(key, { contentType, expiresIn }) {
        return {
          url: sasUrl(key, "cw", expiresIn),
          method: "PUT",
          headers: { "content-type": contentType, "x-ms-blob-type": "BlockBlob", "x-ms-blob-content-type": contentType },
        };
      },
      publicUrl: (key) =>
        ctx.config.publicBaseUrl ? `${ctx.config.publicBaseUrl.replace(/\/$/, "")}/${encodeKey(assertSafeKey(key))}` : null,
      async delete(key) {
        await blob(key).deleteIfExists();
      },
      async *list(prefix) {
        for await (const item of container.listBlobsFlat({ prefix })) yield item.name;
      },
    };
    return provider;
  },
};
