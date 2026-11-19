import { sql, type SQL } from "@shopkit/db";
import { AppError } from "../errors.js";

export type Cast = "timestamptz" | "bigint" | "int" | "text" | "uuid";

/** One keyset ordering: every key sorts in the same direction; the row id breaks ties. */
export interface SortSpec<Row> {
  keys: { expr: SQL; cast: Cast; value: (row: Row) => unknown }[];
  dir: "asc" | "desc";
  id: SQL;
  rowId: (row: Row) => string;
}

export function encodeCursor(values: unknown[]): string {
  return Buffer.from(JSON.stringify(values)).toString("base64url");
}

export function decodeCursor(cursor: string | undefined, length: number): unknown[] | null {
  if (!cursor) return null;
  try {
    const values = JSON.parse(Buffer.from(cursor, "base64url").toString()) as unknown;
    if (Array.isArray(values) && values.length === length) return values as unknown[];
  } catch {
    // fall through
  }
  throw new AppError("bad_request", "Invalid cursor");
}

const castSql = (cast: Cast) => sql.raw(cast);

export function orderBy<Row>(spec: SortSpec<Row>): SQL {
  const dir = sql.raw(spec.dir);
  return sql.join([...spec.keys.map((k) => sql`${k.expr} ${dir} nulls last`), sql`${spec.id} ${dir}`], sql`, `);
}

/** `(k1, k2, id) > (v1, v2, vid)` (or `<` for desc). Nulls are coalesced so tuples stay comparable. */
export function afterCursor<Row>(spec: SortSpec<Row>, cursor: string | undefined): SQL {
  const values = decodeCursor(cursor, spec.keys.length + 1);
  if (!values) return sql`true`;
  const op = spec.dir === "asc" ? sql`>` : sql`<`;
  const left = sql.join([...spec.keys.map((k) => k.expr), spec.id], sql`, `);
  const right = sql.join(
    [...spec.keys.map((k, i) => sql`${values[i] as string}::${castSql(k.cast)}`), sql`${values.at(-1) as string}::uuid`],
    sql`, `,
  );
  return sql`(${left}) ${op} (${right})`;
}

export function page<Row>(spec: SortSpec<Row>, rows: Row[], limit: number) {
  const items = rows.slice(0, limit);
  const last = items.at(-1);
  return {
    items,
    nextCursor: rows.length > limit && last ? encodeCursor([...spec.keys.map((k) => k.value(last)), spec.rowId(last)]) : null,
  };
}
