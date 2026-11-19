import type { collections, products} from "@shopkit/db";
import { and, eq, ne, sql, type Executor } from "@shopkit/db";

/** URL handle like Shopify's: lowercase, unicode letters/digits kept, everything else → "-". */
export function slugify(input: string): string {
  const slug = input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 200)
    .replace(/-+$/g, "");
  return slug;
}

export const HANDLE_RE = /^[\p{Ll}\p{Lo}\p{N}]+(?:-[\p{Ll}\p{Lo}\p{N}]+)*$/u;


/** Returns `base`, or `base-2`, `base-3`… if taken by another row of the same store. */
export async function uniqueHandle(db: Executor, t: typeof products | typeof collections, storeId: string, base: string, excludeId?: string): Promise<string> {
  const root = base || "item";
  const rows = (await db
    .select({ handle: t.handle })
    .from(t)
    .where(
      and(
        eq(t.storeId, storeId),
        sql`(${t.handle} = ${root} or ${t.handle} like ${`${root.replace(/[\\%_]/g, "\\$&")}-%`})`,
        excludeId ? ne(t.id, excludeId) : undefined,
      ),
    )) as { handle: string }[];
  const taken = new Set(rows.map((r) => r.handle.toLowerCase()));
  if (!taken.has(root)) return root;
  for (let i = 2; ; i++) if (!taken.has(`${root}-${i}`)) return `${root}-${i}`;
}
