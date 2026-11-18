import { AppError } from "@shopkit/core";
import type { FastifyRequest } from "fastify";

/** Reads the single multipart file field "file" into memory (size-limited by @fastify/multipart). */
export async function readUpload(req: FastifyRequest): Promise<{ filename: string; data: Buffer }> {
  if (!req.isMultipart()) throw new AppError("bad_request", "Send the image as multipart/form-data");
  const file = await req.file();
  if (!file) throw new AppError("bad_request", "Choose a file to upload");
  const data = await file.toBuffer().catch(() => {
    throw new AppError("validation_failed", "Images must be 5 MB or smaller");
  });
  return { filename: file.filename, data };
}
