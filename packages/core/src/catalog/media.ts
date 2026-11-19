import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { buffer as readAll } from "node:stream/consumers";
import { and, collections, eq, media, stores, UUID_RE, uuidv7, type MediaRendition } from "@shopkit/db";
import { z } from "zod";
import { writeAudit } from "../audit.js";
import { loadProvider } from "../credentials.js";
import type { Actor, CoreDeps } from "../deps.js";
import { AppError, notFound } from "../errors.js";
import { activeStorage, MAX_UPLOAD_BYTES, sniffImage } from "../media.js";
import { enqueueEvent } from "../outbox.js";
import { mediaView } from "./media-view.js";

const PRODUCT_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "image/avif"]);
const IMMUTABLE = "public, max-age=31536000, immutable";
const UPLOAD_URL_TTL = 15 * 60;

export const mediaUploadInput = z.object({
  filename: z.string().trim().min(1).max(255),
  contentType: z.string().refine((t) => PRODUCT_TYPES.has(t), "Upload a PNG, JPEG, WebP, GIF or AVIF image"),
  byteSize: z.number().int().min(1).max(MAX_UPLOAD_BYTES, "Images must be 20 MB or smaller"),
  alt: z.string().trim().max(512).optional(),
});
export type MediaUploadInput = z.input<typeof mediaUploadInput>;

const safeName = (name: string, ext: string) => {
  const base = name.replace(/\.[^.]*$/, "").normalize("NFKD").replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "image";
  return `${base}.${ext}`;
};
const extOf = (contentType: string) => (contentType === "image/jpeg" ? "jpg" : contentType.split("/")[1]!);
const originalKey = (id: string, ext: string) => `media/${id}/original.${ext}`;

/**
 * Step 1 of an upload. When the active provider supports presigned uploads, returns a URL the browser
 * PUTs to directly (then calls completeMediaUpload); otherwise `upload` is null and the browser posts
 * the file to the API (uploadMedia).
 */
export async function createMediaUpload(deps: CoreDeps, actor: Actor, storeId: string, input: MediaUploadInput) {
  const data = mediaUploadInput.parse(input);
  const { provider, id: providerId } = await activeStorage(deps, storeId);
  if (!provider.createUploadUrl) return { mediaId: null, upload: null };
  const id = uuidv7();
  const ext = extOf(data.contentType);
  const key = originalKey(id, ext);
  const upload = await provider.createUploadUrl(key, { contentType: data.contentType, cacheControl: IMMUTABLE, expiresIn: UPLOAD_URL_TTL });
  await deps.db.transaction(async (tx) => {
    await tx.insert(media).values({
      id,
      storeId,
      storageProvider: providerId,
      storageKey: key,
      filename: safeName(data.filename, ext),
      contentType: data.contentType,
      byteSize: data.byteSize,
      checksumSha256: "",
      alt: data.alt ?? null,
      status: "pending",
    });
    await writeAudit(tx, actor, { storeId, action: "media.upload_started", resourceType: "media", resourceId: id });
  });
  return { mediaId: id, upload };
}

/** Step 2 of a direct upload: re-reads the object, enforces size and real type, then marks it ready. */
export async function completeMediaUpload(deps: CoreDeps, actor: Actor, storeId: string, mediaId: string) {
  const [row] = await deps.db.select().from(media).where(and(eq(media.storeId, storeId), eq(media.id, mediaId)));
  if (!row) throw notFound("Image");
  if (row.status === "ready") return mediaView(deps, row);
  const provider = await loadProvider(deps, { storeId, kind: "storage", provider: row.storageProvider, mode: "live" });
  if (!provider) throw new AppError("bad_request", "Storage is not configured");
  const object = await provider.get(row.storageKey);
  if (!object) throw new AppError("validation_failed", "The upload did not reach storage; try again");
  const data = await readLimited(object.body, MAX_UPLOAD_BYTES);
  const kind = data ? sniffImage(data) : null;
  if (!data || !kind || !PRODUCT_TYPES.has(kind.contentType)) {
    await provider.delete(row.storageKey).catch(() => undefined);
    await deps.db.update(media).set({ status: "failed", processingError: data ? "Not an image" : "Too large" }).where(eq(media.id, mediaId));
    throw new AppError("validation_failed", data ? "Upload a PNG, JPEG, WebP, GIF or AVIF image" : "Images must be 20 MB or smaller");
  }
  return deps.db.transaction(async (tx) => {
    const [updated] = await tx
      .update(media)
      .set({ status: "ready", contentType: kind.contentType, byteSize: data.length, checksumSha256: sha256(data) })
      .where(eq(media.id, mediaId))
      .returning();
    await enqueueEvent(tx, { storeId, type: "media.created", payload: { mediaId } });
    await writeAudit(tx, actor, { storeId, action: "media.uploaded", resourceType: "media", resourceId: mediaId });
    return mediaView(deps, updated!);
  });
}

/** Upload through the API (providers without presigned uploads, or as a fallback). */
export async function uploadMedia(
  deps: CoreDeps,
  actor: Actor,
  storeId: string,
  file: { filename: string; data: Buffer; alt?: string | null; sourceUrl?: string | null },
) {
  if (file.data.length === 0) throw new AppError("validation_failed", "File is empty");
  if (file.data.length > MAX_UPLOAD_BYTES) throw new AppError("validation_failed", "Images must be 20 MB or smaller");
  const kind = sniffImage(file.data);
  if (!kind || !PRODUCT_TYPES.has(kind.contentType)) throw new AppError("validation_failed", "Upload a PNG, JPEG, WebP, GIF or AVIF image");
  const { provider, id: providerId } = await activeStorage(deps, storeId);
  const id = uuidv7();
  const key = originalKey(id, kind.ext);
  await provider.put(key, file.data, { contentType: kind.contentType, cacheControl: IMMUTABLE });
  return deps.db.transaction(async (tx) => {
    const [row] = await tx
      .insert(media)
      .values({
        id,
        storeId,
        storageProvider: providerId,
        storageKey: key,
        filename: safeName(file.filename, kind.ext),
        contentType: kind.contentType,
        byteSize: file.data.length,
        checksumSha256: sha256(file.data),
        alt: file.alt?.trim() || null,
        sourceUrl: file.sourceUrl ?? null,
        status: "ready",
      })
      .returning();
    await enqueueEvent(tx, { storeId, type: "media.created", payload: { mediaId: id } });
    await writeAudit(tx, actor, { storeId, action: "media.uploaded", resourceType: "media", resourceId: id });
    return mediaView(deps, row!);
  });
}

export async function updateMediaAlt(deps: CoreDeps, actor: Actor, storeId: string, mediaId: string, alt: string | null) {
  return deps.db.transaction(async (tx) => {
    const [row] = await tx
      .update(media)
      .set({ alt: alt?.trim() || null })
      .where(and(eq(media.storeId, storeId), eq(media.id, mediaId)))
      .returning();
    if (!row) throw notFound("Image");
    await enqueueEvent(tx, { storeId, type: "media.created", payload: { mediaId, altOnly: true } });
    await writeAudit(tx, actor, { storeId, action: "media.updated", resourceType: "media", resourceId: mediaId });
    return mediaView(deps, row);
  });
}

/** Deletes the row now; storage objects are removed by the worker (outbox `media.deleted`). */
export async function deleteMedia(deps: CoreDeps, actor: Actor, storeId: string, mediaId: string) {
  await deps.db.transaction(async (tx) => {
    const [store] = await tx.select({ logo: stores.logoMediaId, favicon: stores.faviconMediaId }).from(stores).where(eq(stores.id, storeId));
    if (store && (store.logo === mediaId || store.favicon === mediaId)) throw new AppError("conflict", "This image is the store logo or favicon");
    const [row] = await tx.delete(media).where(and(eq(media.storeId, storeId), eq(media.id, mediaId))).returning();
    if (!row) throw notFound("Image");
    await tx.update(collections).set({ imageMediaId: null }).where(eq(collections.imageMediaId, mediaId));
    await enqueueEvent(tx, {
      storeId,
      type: "media.deleted",
      payload: { mediaId, provider: row.storageProvider, keys: [row.storageKey, ...row.renditions.map((r) => r.key)] },
    });
    await writeAudit(tx, actor, { storeId, action: "media.deleted", resourceType: "media", resourceId: mediaId });
  });
}

/** Worker side of `media.deleted`. */
export async function deleteStoredObjects(deps: CoreDeps, storeId: string, providerId: string, keys: string[]) {
  const provider = await loadProvider(deps, { storeId, kind: "storage", provider: providerId, mode: "live" });
  if (!provider) return { deleted: 0 };
  for (const key of keys) await provider.delete(key);
  return { deleted: keys.length };
}

// ── Image processing (images queue) ─────────────────────────────────────────
export const RENDITION_WIDTHS = [160, 320, 640, 1024, 1600, 2048] as const;
const PROCESSABLE = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "image/avif"]);

/**
 * Re-encodes an original into WebP + AVIF renditions (SPEC §10 "image re-encoding"), stripping
 * metadata and applying EXIF orientation. Idempotent: renditions are recreated with the same keys.
 */
export async function processMedia(deps: CoreDeps, mediaId: string): Promise<{ status: "processed" | "skipped"; renditions?: number; reason?: string }> {
  if (!UUID_RE.test(mediaId)) return { status: "skipped", reason: "invalid media id" };
  const [row] = await deps.db.select().from(media).where(eq(media.id, mediaId));
  if (!row) return { status: "skipped", reason: "media deleted" };
  if (row.status !== "ready") return { status: "skipped", reason: `media is ${row.status}` };
  if (!PROCESSABLE.has(row.contentType)) return { status: "skipped", reason: `cannot process ${row.contentType}` };
  const provider = await loadProvider(deps, { storeId: row.storeId, kind: "storage", provider: row.storageProvider, mode: "live" });
  if (!provider) throw new Error(`storage provider ${row.storageProvider} is not configured`);
  const object = await provider.get(row.storageKey);
  if (!object) throw new Error(`original ${row.storageKey} is missing`);
  const original = await readAll(object.body);

  const { default: sharp } = await import("sharp");
  let meta;
  try {
    meta = await sharp(original, { failOn: "error" }).rotate().metadata();
  } catch (err) {
    await deps.db.update(media).set({ processingError: (err as Error).message.slice(0, 500), processedAt: new Date() }).where(eq(media.id, mediaId));
    return { status: "skipped", reason: "unreadable image" };
  }
  const swap = (meta.orientation ?? 1) >= 5;
  const width = (swap ? meta.height : meta.width) ?? 0;
  const height = (swap ? meta.width : meta.height) ?? 0;
  const widths = [...new Set([...RENDITION_WIDTHS.filter((w) => w < width), Math.min(width, 2048)])].filter((w) => w > 0);
  const dir = row.storageKey.replace(/\/[^/]+$/, "");
  const renditions: MediaRendition[] = [];
  for (const w of widths) {
    for (const format of ["webp", "avif"] as const) {
      const pipeline = sharp(original, { animated: false }).rotate().resize({ width: w, withoutEnlargement: true });
      let out;
      try {
        out = await (format === "webp" ? pipeline.webp({ quality: 80 }) : pipeline.avif({ quality: 50, effort: 2 })).toBuffer({ resolveWithObject: true });
      } catch (err) {
        // Corrupt image data never decodes: record it instead of retrying the job (storage errors still retry).
        await deps.db.update(media).set({ processingError: (err as Error).message.slice(0, 500), processedAt: new Date() }).where(eq(media.id, mediaId));
        return { status: "skipped", reason: "image could not be decoded" };
      }
      const key = `${dir}/w${w}.${format}`;
      await provider.put(key, out.data, { contentType: `image/${format}`, cacheControl: IMMUTABLE });
      renditions.push({ width: out.info.width, height: out.info.height, format, key, bytes: out.data.length });
    }
  }
  await deps.db.transaction(async (tx) => {
    await tx.update(media).set({ width, height, renditions, processedAt: new Date(), processingError: null }).where(eq(media.id, mediaId));
    await enqueueEvent(tx, { storeId: row.storeId, type: "media.processed", payload: { mediaId } });
  });
  return { status: "processed", renditions: renditions.length };
}

// ── Remote images (CSV import) ───────────────────────────────────────────────
const PRIVATE_V4 = [/^0\./, /^10\./, /^127\./, /^169\.254\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, /^22[4-9]\./, /^2[3-5]\d\./];
function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) return PRIVATE_V4.some((re) => re.test(ip));
  const v6 = ip.toLowerCase();
  if (v6.startsWith("::ffff:")) return isPrivateAddress(v6.slice(7));
  return v6 === "::1" || v6 === "::" || v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe8") || v6.startsWith("fe9") || v6.startsWith("fea") || v6.startsWith("feb") || v6.startsWith("ff");
}

/** SSRF guard for merchant-supplied URLs: http(s) only, and every resolved address must be public. */
export async function assertPublicUrl(raw: string, allowPrivate = false): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AppError("validation_failed", "Image URL is not valid");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new AppError("validation_failed", "Image URLs must be http(s)");
  if (url.username || url.password) throw new AppError("validation_failed", "Image URLs must not contain credentials");
  if (allowPrivate) return url;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true }).catch(() => []);
  if (addresses.length === 0) throw new AppError("validation_failed", `Could not resolve ${host}`);
  if (addresses.some((a) => isPrivateAddress(a.address))) throw new AppError("validation_failed", `${host} is not a public address`);
  return url;
}

async function readLimited(body: NodeJS.ReadableStream | AsyncIterable<Uint8Array>, limit: number): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of body as AsyncIterable<Uint8Array | string>) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
    size += buf.length;
    if (size > limit) return null;
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

/** Downloads an image by URL into the media library; reuses an earlier import of the same URL. */
export async function importMediaFromUrl(
  deps: CoreDeps,
  actor: Actor,
  storeId: string,
  rawUrl: string,
  opts: { alt?: string | null; allowPrivate?: boolean } = {},
) {
  const [existing] = await deps.db.select().from(media).where(and(eq(media.storeId, storeId), eq(media.sourceUrl, rawUrl), eq(media.status, "ready"))).limit(1);
  if (existing) return existing.id;
  let url = await assertPublicUrl(rawUrl, opts.allowPrivate);
  let res: Response | null = null;
  for (let hop = 0; hop < 4; hop++) {
    res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(20_000), headers: { "user-agent": "Shopkit-Importer/1.0", accept: "image/*" } });
    if (res.status < 300 || res.status >= 400) break;
    const next = res.headers.get("location");
    if (!next) break;
    url = await assertPublicUrl(new URL(next, url).toString(), opts.allowPrivate);
  }
  if (!res || !res.ok || !res.body) throw new AppError("validation_failed", `Image download failed (${res?.status ?? "no response"})`);
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > MAX_UPLOAD_BYTES) throw new AppError("validation_failed", "Image is larger than 20 MB");
  const data = await readLimited(res.body, MAX_UPLOAD_BYTES);
  if (!data) throw new AppError("validation_failed", "Image is larger than 20 MB");
  const name = decodeURIComponent(url.pathname.split("/").pop() || "image");
  const view = await uploadMedia(deps, actor, storeId, { filename: name, data, alt: opts.alt ?? null, sourceUrl: rawUrl });
  return view.id;
}

const sha256 = (data: Buffer) => createHash("sha256").update(data).digest("hex");
