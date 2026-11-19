import { createHash } from "node:crypto";
import { and, eq, media, stores, uuidv7 } from "@shopkit/db";
import type { StoredObject } from "@shopkit/providers";
import { writeAudit } from "./audit.js";
import { loadProvider } from "./credentials.js";
import type { Actor, CoreDeps } from "./deps.js";
import { AppError } from "./errors.js";
import { enqueueEvent } from "./outbox.js";
import { getSetting } from "./settings.js";

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** Product/collection images and CSV files (the API's multipart limit). */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/** Content sniffing: trust the bytes, not the browser's Content-Type. SVG is refused (script risk). */
export function sniffImage(data: Buffer): { contentType: string; ext: string } | null {
  const at = (i: number, bytes: number[]) => bytes.every((b, j) => data[i + j] === b);
  if (at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { contentType: "image/png", ext: "png" };
  if (at(0, [0xff, 0xd8, 0xff])) return { contentType: "image/jpeg", ext: "jpg" };
  if (at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50])) return { contentType: "image/webp", ext: "webp" };
  if (at(0, [0x47, 0x49, 0x46, 0x38])) return { contentType: "image/gif", ext: "gif" };
  if (at(0, [0x00, 0x00, 0x01, 0x00])) return { contentType: "image/x-icon", ext: "ico" };
  if (at(4, [0x66, 0x74, 0x79, 0x70]) && (at(8, [0x61, 0x76, 0x69, 0x66]) || at(8, [0x61, 0x76, 0x69, 0x73]))) return { contentType: "image/avif", ext: "avif" };
  return null;
}

export async function activeStorage(deps: CoreDeps, storeId: string) {
  const active = await getSetting(deps.db, storeId, "storage.active");
  const provider = await loadProvider(deps, { storeId, kind: "storage", provider: active.provider, mode: active.mode });
  if (!provider) throw new AppError("bad_request", "Storage is not configured");
  return { provider, id: active.provider };
}

export type BrandAsset = "logo" | "favicon";

/** Uploads a brand image to the active storage provider and points the store at it. */
export async function uploadBrandAsset(
  deps: CoreDeps,
  actor: Actor,
  storeId: string,
  asset: BrandAsset,
  file: { filename: string; data: Buffer },
) {
  if (file.data.length === 0) throw new AppError("validation_failed", "File is empty");
  if (file.data.length > MAX_IMAGE_BYTES) throw new AppError("validation_failed", "Images must be 5 MB or smaller");
  const kind = sniffImage(file.data);
  if (!kind) throw new AppError("validation_failed", "Upload a PNG, JPEG, WebP, GIF or ICO image");

  const { provider, id: providerId } = await activeStorage(deps, storeId);
  const id = uuidv7();
  const filename = `${asset}.${kind.ext}`;
  const key = `brand/${id}.${kind.ext}`;
  await provider.put(key, file.data, { contentType: kind.contentType, cacheControl: "public, max-age=31536000, immutable" });

  return deps.db.transaction(async (tx) => {
    const [row] = await tx
      .insert(media)
      .values({
        id,
        storeId,
        storageProvider: providerId,
        storageKey: key,
        filename,
        contentType: kind.contentType,
        byteSize: file.data.length,
        checksumSha256: createHash("sha256").update(file.data).digest("hex"),
        alt: asset === "logo" ? "Logo" : null,
        visibility: "public",
      })
      .returning();
    await tx
      .update(stores)
      .set(asset === "logo" ? { logoMediaId: id } : { faviconMediaId: id })
      .where(eq(stores.id, storeId));
    await enqueueEvent(tx, { storeId, type: "media.created", payload: { mediaId: id, purpose: asset } });
    await writeAudit(tx, actor, { storeId, action: `store.${asset}_uploaded`, resourceType: "media", resourceId: id });
    return row!;
  });
}

/** Streams a public media object for the /media proxy. */
export type MediaRead = { redirect: string } | { object: StoredObject; contentType: string };

const RENDITION_RE = /^w(\d{2,4})\.(webp|avif)$/;

/**
 * Resolves `/media/<id>/<file>`: the original (any file name, for stable URLs) or a rendition
 * (`w640.webp`). Redirects to the provider's public URL when one exists, else streams the object.
 */
export async function readMedia(deps: CoreDeps, mediaId: string, filename?: string): Promise<MediaRead | null> {
  const [row] = await deps.db.select().from(media).where(and(eq(media.id, mediaId), eq(media.visibility, "public")));
  if (!row || row.status !== "ready") return null;
  let key = row.storageKey;
  let contentType = row.contentType;
  const m = filename ? RENDITION_RE.exec(filename) : null;
  if (m) {
    const r = row.renditions.find((x) => x.width === Number(m[1]) && x.format === m[2]);
    if (!r) return null;
    key = r.key;
    contentType = `image/${r.format}`;
  }
  const provider = await loadProvider(deps, { storeId: row.storeId, kind: "storage", provider: row.storageProvider, mode: "live" });
  if (!provider) return null;
  const direct = provider.publicUrl(key);
  if (direct) return { redirect: direct };
  const object = await provider.get(key);
  return object ? { object, contentType } : null;
}

/** Streams an object for a verified `/media/s/<store>/<provider>/<key>` signed URL. */
export async function readSignedObject(deps: CoreDeps, storeId: string, providerId: string, key: string): Promise<StoredObject | null> {
  const provider = await loadProvider(deps, { storeId, kind: "storage", provider: providerId, mode: "live" });
  if (!provider) return null;
  try {
    return await provider.get(key);
  } catch {
    return null;
  }
}
