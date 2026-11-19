import { sql, type SQL } from "@shopkit/db";

/** Words → prefix tsquery ("red sh" → "red:* & sh:*"). Returns null when nothing searchable remains. */
export function prefixQuery(q: string): string | null {
  const words = q.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  if (words.length === 0) return null;
  return words.slice(0, 10).map((w) => `${w}:*`).join(" & ");
}

/**
 * Postgres full-text (title A, vendor/type/tags/SKU B, description C) with prefix matching, or a
 * substring of the title. Over a `products` row aliased `p`.
 */
export function productTextMatch(q: string): SQL {
  const tsq = prefixQuery(q);
  const like = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
  if (!tsq) return sql`p.title ilike ${like}`;
  return sql`(p.search_vector @@ to_tsquery('simple', ${tsq}) or p.title ilike ${like})`;
}

/** Typo-tolerant fallback (pg_trgm on the title), used only when nothing matches exactly. */
export function productFuzzyMatch(q: string): SQL {
  return sql`similarity(p.title, ${q}) > 0.3`;
}

/**
 * Exact matches when there are any, else trigram matches. Decided once per query (not per page)
 * so cursors stay consistent; `scope` is the rest of the WHERE clause.
 */
export async function productTextCondition(db: { execute: (q: SQL) => Promise<{ rows: unknown[] }> }, scope: SQL, q: string): Promise<SQL> {
  const exact = productTextMatch(q);
  const { rows } = await db.execute(sql`select 1 from products p where ${scope} and ${exact} limit 1`);
  return rows.length ? exact : productFuzzyMatch(q);
}

export function productTextRank(q: string): SQL {
  const tsq = prefixQuery(q) ?? "";
  return sql`(ts_rank(p.search_vector, to_tsquery('simple', ${tsq})) + similarity(p.title, ${q}))`;
}
