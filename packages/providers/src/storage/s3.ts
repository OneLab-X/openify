import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { z } from "zod";
import { errorMessage } from "../http.js";
import type { ProviderContext, ProviderDefinition, StorageProvider } from "../types.js";
import { assertSafeKey, encodeKey, PROBE_PREFIX } from "./keys.js";

const baseConfig = {
  bucket: z.string().min(3).max(63).meta({ title: "Bucket" }),
  region: z.string().min(1).default("us-east-1").meta({ title: "Region" }),
  publicBaseUrl: z
    .url()
    .optional()
    .meta({
      title: "Public base URL",
      description: "CDN or public bucket URL. Leave empty to serve files through the shop's /media proxy.",
    }),
};
const s3Config = z.object(baseConfig);
const compatibleConfig = z.object({
  endpoint: z.url().meta({ title: "Endpoint", description: "e.g. http://minio:9000" }),
  ...baseConfig,
  forcePathStyle: z.boolean().default(true).meta({ title: "Path-style URLs", description: "Needed for MinIO" }),
});
const secretsSchema = z.object({
  accessKeyId: z.string().min(3).meta({ title: "Access key ID" }),
  secretAccessKey: z.string().min(8).meta({ title: "Secret access key" }),
});
type S3Config = z.infer<typeof compatibleConfig>;
type S3Secrets = z.infer<typeof secretsSchema>;

function s3Error(err: unknown): string {
  if (err instanceof S3ServiceException) {
    const status = err.$metadata.httpStatusCode;
    if (err.name === "NoSuchBucket") return "Bucket does not exist";
    if (status === 403 || err.name === "InvalidAccessKeyId" || err.name === "SignatureDoesNotMatch") {
      return "Access denied: check the access key, secret and bucket permissions";
    }
    return `${err.name}${status ? ` (${status})` : ""}: ${err.message}`;
  }
  return errorMessage(err);
}

export function createS3Storage(ctx: ProviderContext<Partial<S3Config> & z.infer<typeof s3Config>, S3Secrets>): StorageProvider {
  const { bucket, region, endpoint, forcePathStyle, publicBaseUrl } = ctx.config;
  const client = new S3Client({
    region,
    ...(endpoint ? { endpoint } : {}),
    forcePathStyle: forcePathStyle ?? false,
    credentials: { accessKeyId: ctx.secrets.accessKeyId, secretAccessKey: ctx.secrets.secretAccessKey },
    maxAttempts: 2,
  });

  const provider: StorageProvider = {
    async testCredentials() {
      const key = `${PROBE_PREFIX}/${randomUUID()}.txt`;
      try {
        await provider.put(key, Buffer.from("shopkit probe"), { contentType: "text/plain" });
        await provider.delete(key);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: s3Error(err) };
      }
    },
    async put(key, body, { contentType, cacheControl }) {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: assertSafeKey(key),
          Body: body,
          ContentType: contentType,
          ...(cacheControl ? { CacheControl: cacheControl } : {}),
        }),
      );
    },
    async get(key) {
      try {
        const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: assertSafeKey(key) }));
        if (!res.Body) return null;
        return {
          body: res.Body as Readable,
          ...(res.ContentType ? { contentType: res.ContentType } : {}),
          ...(res.ContentLength !== undefined ? { contentLength: res.ContentLength } : {}),
        };
      } catch (err) {
        if (err instanceof NoSuchKey) return null;
        throw err;
      }
    },
    getSignedUrl: (key, { expiresIn }) =>
      getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: assertSafeKey(key) }), { expiresIn }),
    publicUrl: (key) => (publicBaseUrl ? `${publicBaseUrl.replace(/\/$/, "")}/${encodeKey(assertSafeKey(key))}` : null),
    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: assertSafeKey(key) }));
    },
    async *list(prefix) {
      let token: string | undefined;
      do {
        const page = await client.send(
          new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }),
        );
        for (const obj of page.Contents ?? []) if (obj.Key) yield obj.Key;
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
    },
  };
  return provider;
}

export const s3Storage: ProviderDefinition<"storage", z.infer<typeof s3Config>, S3Secrets> = {
  id: "s3",
  kind: "storage",
  displayName: "Amazon S3",
  modes: ["live"],
  configSchema: s3Config,
  secretsSchema,
  last4Field: "secretAccessKey",
  create: createS3Storage,
};

export const s3CompatibleStorage: ProviderDefinition<"storage", S3Config, S3Secrets> = {
  id: "s3-compatible",
  kind: "storage",
  displayName: "MinIO / S3-compatible",
  description: "MinIO (docker compose --profile minio) or any S3-compatible endpoint.",
  modes: ["live"],
  configSchema: compatibleConfig,
  secretsSchema,
  last4Field: "secretAccessKey",
  create: createS3Storage,
};
