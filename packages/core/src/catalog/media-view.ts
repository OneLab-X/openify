import { inArray, media, type Executor } from "@shopkit/db";
import type { CoreDeps } from "../deps.js";

type MediaRow = typeof media.$inferSelect;

export interface MediaView {
  id: string;
  url: string;
  alt: string | null;
  width: number | null;
  height: number | null;
  contentType: string;
  status: "pending" | "ready" | "failed";
  processed: boolean;
  /** Resized renditions; empty until the images queue has run. */
  sources: { width: number; format: "webp" | "avif"; url: string }[];
}

/**
 * URLs always go through /media/<id>/<file> on the shop's origin: the proxy streams private objects
 * and redirects to the provider's public URL when one is configured, so views never load providers.
 */
export function mediaView(deps: Pick<CoreDeps, "runtime">, row: MediaRow): MediaView {
  const base = `${deps.runtime.publicUrl}/media/${row.id}`;
  return {
    id: row.id,
    url: `${base}/${encodeURIComponent(row.filename)}`,
    alt: row.alt,
    width: row.width,
    height: row.height,
    contentType: row.contentType,
    status: row.status,
    processed: row.processedAt !== null,
    sources: row.renditions
      .map((r) => ({ width: r.width, format: r.format, url: `${base}/w${r.width}.${r.format}` }))
      .sort((a, b) => a.width - b.width),
  };
}

export async function mediaByIds(db: Executor, ids: string[]): Promise<Map<string, MediaRow>> {
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return new Map();
  const rows = await db.select().from(media).where(inArray(media.id, unique));
  return new Map(rows.map((r) => [r.id, r]));
}
