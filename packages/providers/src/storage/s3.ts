import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { z } from "zod";
import { errorMessage } from "../http.js";
import type { ProviderContext, ProviderDefinition, StorageProvider } from "../types.js";
import { assertSafeKey, encodeKey, PROBE_PREFIX } from "./keys.js";

const bucket = z.string().min(3).max(63).meta({ title: "Bucket" });
const publicBaseUrl = z
  .url()
  .optional()
  .meta({
    title: "Public base URL",
    description: "CDN or public bucket URL. Leave empty to serve files through the shop's /media proxy.",
  });

const s3Config = z.object({
  bucket,
  region: z.string().min(1).default("us-east-1").meta({ title: "Region" }),
  publicBaseUrl,
});
const compatibleConfig = z.object({
  endpoint: z.url().meta({ title: "Endpoint", description: "e.g. http://minio:9000" }),
  bucket,
  region: z.string().min(1).default("us-east-1").meta({ title: "Region" }),
  publicBaseUrl,
  forcePathStyle: z.boolean().default(true).meta({ title: "Path-style URLs", description: "Needed for MinIO" }),
});
const r2Config = z.object({
  accountId: z
    .string()
    .regex(/^[a-f0-9]{32}$/i, "32-character account ID from the Cloudflare dashboard")
    .meta({ title: "Account ID" }),
  bucket,
  publicBaseUrl: publicBaseUrl.meta({
    title: "Public base URL",
    description: "r2.dev or custom domain bound to the bucket. Leave empty to serve files through /media.",
  }),
  endpoint: z
    .url()
    .optional()
    .meta({ title: "Custom endpoint (advanced)", description: "Only for EU/FedRAMP jurisdictions, e.g. https://<account>.eu.r2.cloudflarestorage.com" }),
});
const b2Config = z.object({
  region: z
    .string()
    .regex(/^[a-z]+-[a-z]+-\d{3}$/, "e.g. us-west-004 (from the bucket's S3 endpoint)")
    .meta({ title: "Region", description: "From the bucket's endpoint s3.<region>.backblazeb2.com" }),
  bucket: z.string().min(6).max(63).meta({ title: "Bucket" }),
  publicBaseUrl: publicBaseUrl.meta({
    title: "Public base URL",
    description: "e.g. https://f004.backblazeb2.com/file/<bucket> for public buckets, or your CDN.",
  }),
  endpoint: z.url().optional().meta({ title: "Custom endpoint (advanced)" }),
});

const secretsSchema = z.object({
  accessKeyId: z.string().min(3).meta({ title: "Access key ID" }),
  secretAccessKey: z.string().min(8).meta({ title: "Secret access key" }),
});
const b2Secrets = z.object({
  accessKeyId: z.string().min(3).meta({ title: "Application key ID" }),
  secretAccessKey: z.string().min(8).meta({ title: "Application key" }),
});

type S3Secrets = z.infer<typeof secretsSchema>;
/** Normalised settings every S3-API adapter maps onto. */
export interface S3Settings {
  bucket: string;
  region: string;
  endpoint?: string | undefined;
  forcePathStyle?: boolean | undefined;
  publicBaseUrl?: string | undefined;
}

const PART_SIZE = 8 * 1024 * 1024;

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

/** One implementation for AWS S3, MinIO/RustFS, Cloudflare R2 and Backblaze B2 (all speak the S3 API). */
export function createS3Storage(settings: S3Settings, secrets: S3Secrets): StorageProvider {
  const { bucket, region, endpoint, forcePathStyle, publicBaseUrl } = settings;
  const client = new S3Client({
    region,
    ...(endpoint ? { endpoint } : {}),
    forcePathStyle: forcePathStyle ?? false,
    credentials: { accessKeyId: secrets.accessKeyId, secretAccessKey: secrets.secretAccessKey },
    maxAttempts: 2,
    // R2, B2 and older MinIO reject the SDK's default CRC32 flexible checksums.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
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
      const base = { Bucket: bucket, Key: assertSafeKey(key), ContentType: contentType, ...(cacheControl ? { CacheControl: cacheControl } : {}) };
      if (Buffer.isBuffer(body)) {
        await client.send(new PutObjectCommand({ ...base, Body: body }));
        return;
      }
      // Streams have no length: one PutObject when small, multipart (8 MiB parts) otherwise.
      let pending: Buffer[] = [];
      let size = 0;
      let uploadId: string | undefined;
      const parts: { ETag: string | undefined; PartNumber: number }[] = [];
      const flushPart = async () => {
        uploadId ??= (await client.send(new CreateMultipartUploadCommand(base))).UploadId;
        const PartNumber = parts.length + 1;
        const res = await client.send(new UploadPartCommand({ Bucket: bucket, Key: base.Key, UploadId: uploadId, PartNumber, Body: Buffer.concat(pending) }));
        parts.push({ ETag: res.ETag, PartNumber });
        pending = [];
        size = 0;
      };
      try {
        for await (const chunk of body as AsyncIterable<Buffer | string>) {
          const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
          pending.push(buf);
          size += buf.length;
          if (size >= PART_SIZE) await flushPart();
        }
        if (!uploadId) {
          await client.send(new PutObjectCommand({ ...base, Body: Buffer.concat(pending) }));
          return;
        }
        if (size > 0) await flushPart();
        await client.send(new CompleteMultipartUploadCommand({ Bucket: bucket, Key: base.Key, UploadId: uploadId, MultipartUpload: { Parts: parts } }));
      } catch (err) {
        if (uploadId) await client.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: base.Key, UploadId: uploadId })).catch(() => undefined);
        throw err;
      }
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
        if (err instanceof NoSuchKey || (err instanceof S3ServiceException && err.$metadata.httpStatusCode === 404)) return null;
        throw err;
      }
    },
    getSignedUrl: (key, { expiresIn }) =>
      getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: assertSafeKey(key) }), { expiresIn }),
    async createUploadUrl(key, { contentType, cacheControl, expiresIn }) {
      const command = new PutObjectCommand({
        Bucket: bucket,
        Key: assertSafeKey(key),
        ContentType: contentType,
        ...(cacheControl ? { CacheControl: cacheControl } : {}),
      });
      const url = await getSignedUrl(client, command, { expiresIn, signableHeaders: new Set(["content-type"]) });
      return {
        url,
        method: "PUT",
        headers: { "content-type": contentType, ...(cacheControl ? { "cache-control": cacheControl } : {}) },
      };
    },
    publicUrl: (key) => (publicBaseUrl ? `${publicBaseUrl.replace(/\/$/, "")}/${encodeKey(assertSafeKey(key))}` : null),
    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: assertSafeKey(key) }));
    },
    async *list(prefix) {
      let token: string | undefined;
      do {
        const page = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
        for (const obj of page.Contents ?? []) if (obj.Key) yield obj.Key;
        token = page.IsTruncated ? page.NextContinuationToken : undefined;
      } while (token);
    },
  };
  return provider;
}

type S3Cfg = z.infer<typeof s3Config>;
type CompatibleCfg = z.infer<typeof compatibleConfig>;
type R2Cfg = z.infer<typeof r2Config>;
type B2Cfg = z.infer<typeof b2Config>;

export const s3Storage: ProviderDefinition<"storage", S3Cfg, S3Secrets> = {
  id: "s3",
  kind: "storage",
  displayName: "Amazon S3",
  modes: ["live"],
  configSchema: s3Config,
  secretsSchema,
  last4Field: "secretAccessKey",
  create: (ctx: ProviderContext<S3Cfg, S3Secrets>) => createS3Storage(ctx.config, ctx.secrets),
};

export const s3CompatibleStorage: ProviderDefinition<"storage", CompatibleCfg, S3Secrets> = {
  id: "s3-compatible",
  kind: "storage",
  displayName: "MinIO / S3-compatible",
  description: "MinIO (docker compose --profile minio) or any S3-compatible endpoint.",
  modes: ["live"],
  configSchema: compatibleConfig,
  secretsSchema,
  last4Field: "secretAccessKey",
  create: (ctx) => createS3Storage(ctx.config, ctx.secrets),
};

export const r2Storage: ProviderDefinition<"storage", R2Cfg, S3Secrets> = {
  id: "r2",
  kind: "storage",
  displayName: "Cloudflare R2",
  description: "Create an R2 API token with Object Read & Write for the bucket.",
  docsUrl: "https://developers.cloudflare.com/r2/api/s3/tokens/",
  modes: ["live"],
  configSchema: r2Config,
  secretsSchema,
  last4Field: "secretAccessKey",
  create: (ctx) =>
    createS3Storage(
      {
        bucket: ctx.config.bucket,
        region: "auto",
        endpoint: ctx.config.endpoint ?? `https://${ctx.config.accountId}.r2.cloudflarestorage.com`,
        forcePathStyle: true,
        publicBaseUrl: ctx.config.publicBaseUrl,
      },
      ctx.secrets,
    ),
};

export const b2Storage: ProviderDefinition<"storage", B2Cfg, S3Secrets> = {
  id: "b2",
  kind: "storage",
  displayName: "Backblaze B2",
  description: "Uses B2's S3-compatible API. Create an application key restricted to the bucket.",
  docsUrl: "https://www.backblaze.com/docs/cloud-storage-s3-compatible-api",
  modes: ["live"],
  configSchema: b2Config,
  secretsSchema: b2Secrets,
  last4Field: "secretAccessKey",
  create: (ctx) =>
    createS3Storage(
      {
        bucket: ctx.config.bucket,
        region: ctx.config.region,
        endpoint: ctx.config.endpoint ?? `https://s3.${ctx.config.region}.backblazeb2.com`,
        forcePathStyle: true,
        publicBaseUrl: ctx.config.publicBaseUrl,
      },
      ctx.secrets,
    ),
};
