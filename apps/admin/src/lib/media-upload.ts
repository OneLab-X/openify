"use client";
import type { Schemas } from "@shopkit/sdk";
import { api, errorMessage, uploadFile } from "./api-client";

export type Media = Schemas["Media"];

/**
 * Uploads an image straight to the storage provider when it supports presigned uploads (S3, R2, B2,
 * GCS, Azure), falling back to the API (local disk, Google Drive, or a bucket without CORS).
 */
export async function uploadImage(file: File): Promise<Media> {
  const { data: target, error } = await api.POST("/api/admin/media/uploads", {
    body: { filename: file.name, contentType: file.type, byteSize: file.size },
  });
  if (error) throw new Error(errorMessage(error));
  if (target?.upload && target.mediaId) {
    try {
      const put = await fetch(target.upload.url, { method: target.upload.method, headers: target.upload.headers, body: file });
      if (put.ok) {
        const done = await api.POST("/api/admin/media/{id}/complete", { params: { path: { id: target.mediaId } } });
        if (done.data) return done.data;
        throw new Error(errorMessage(done.error));
      }
    } catch (err) {
      if (err instanceof Error && !/fetch|network|cors/i.test(err.message)) throw err;
      // CORS or network failure on the bucket: fall back to the API upload below.
    }
  }
  const res = await uploadFile("/api/admin/media", file);
  if (!res.data) throw new Error(errorMessage(res.error));
  return res.data as unknown as Media;
}
