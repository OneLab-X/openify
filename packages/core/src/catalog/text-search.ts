import { sql, type SQL } from "@shopkit/db";

/** Words → prefix tsquery ("red sh" → "red:* & sh:*"). Returns null when nothing searchable remains. */
export function prefixQuery(q: string): string | null {
  const words = q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  if (words.length === 0) return null;
  return words.slice(0, 10).map((w) => `${w}:*`).join(" & ");
}

/**
 * Postgres full-text (title A, vendor/type/tags/SKU B, description C) OR trigram similarity on the
 * title, so typos still match. Over a `products` row aliased `p`.
 */
export function productTextMatch(q: string): SQL {
  const tsq = prefixQuery(q);
  const like = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
  if (!tsq) return sql`p.title ilike ${like}`;
  return sql`(p.search_vector @@ to_tsquery('simple', ${tsq}) or p.title ilike ${like} or similarity(p.title, ${q}) > 0.3)`;
}

export function productTextRank(q: string): SQL {
  const tsq = prefixQuery(q) ?? "";
  return sql`(ts_rank(p.search_vector, to_tsquery('simple', ${tsq})) + similarity(p.title, ${q}))`;
}
