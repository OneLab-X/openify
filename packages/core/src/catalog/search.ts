import { and, eq, inArray, productTags, products, productVariants, sql, tags, type Db } from "@shopkit/db";
import type { CoreDeps } from "../deps.js";
import { htmlToText } from "./html.js";
import { productTextMatch, productTextRank } from "./text-search.js";

/**
 * Storefront search backend (docs/prompts/02-catalog.md item 7). Postgres full-text + pg_trgm is
 * always available; Meilisearch is used when MEILISEARCH_URL is set (compose profile `meilisearch`).
 * Engines return product ids in relevance order; callers load the rows from Postgres.
 */
export interface SearchEngine {
  readonly id: "postgres" | "meilisearch";
  search(storeId: string, q: string, opts: { limit: number; offset: number }): Promise<{ ids: string[]; total: number }>;
  /** Keeps an external index in sync (no-op for Postgres, whose index is a column). */
  sync(storeId: string, productIds: string[]): Promise<void>;
  /** Rebuilds the whole index for a store. */
  reindex(storeId: string): Promise<number>;
}

export function postgresSearch(db: Db): SearchEngine {
  return {
    id: "postgres",
    async search(storeId, q, { limit, offset }) {
      const where = sql`p.store_id = ${storeId} and p.status = 'active' and ${productTextMatch(q)}`;
      const [{ rows }, count] = await Promise.all([
        db.execute<{ id: string }>(sql`
          select p.id from products p where ${where}
          order by ${productTextRank(q)} desc, p.id limit ${limit} offset ${offset}`),
        db.execute<{ n: number }>(sql`select count(*)::int as n from products p where ${where}`),
      ]);
      return { ids: rows.map((r) => r.id), total: count.rows[0]?.n ?? 0 };
    },
    async sync() {},
    async reindex() {
      return 0;
    },
  };
}

export interface SearchDocument {
  id: string;
  title: string;
  handle: string;
  vendor: string | null;
  productType: string | null;
  tags: string[];
  skus: string[];
  options: string[];
  description: string;
  priceMin: number;
  available: boolean;
  createdAt: number;
}

/** Active products as search documents; ids that are missing or not active are returned as `removed`. */
export async function searchDocuments(db: Db, storeId: string, productIds?: string[]): Promise<{ docs: SearchDocument[]; removed: string[] }> {
  const rows = await db
    .select()
    .from(products)
    .where(and(eq(products.storeId, storeId), productIds ? inArray(products.id, productIds) : undefined));
  const active = rows.filter((r) => r.status === "active");
  const ids = active.map((r) => r.id);
  const [tagRows, variantRows] = ids.length
    ? await Promise.all([
        db.select({ productId: productTags.productId, name: tags.name }).from(productTags).innerJoin(tags, eq(tags.id, productTags.tagId)).where(inArray(productTags.productId, ids)),
        db
          .select({ productId: productVariants.productId, sku: productVariants.sku, o1: productVariants.option1, o2: productVariants.option2, o3: productVariants.option3 })
          .from(productVariants)
          .where(inArray(productVariants.productId, ids)),
      ])
    : [[], []];
  const docs = active.map((p) => {
    const vs = variantRows.filter((v) => v.productId === p.id);
    return {
      id: p.id,
      title: p.title,
      handle: p.handle,
      vendor: p.vendor,
      productType: p.productType,
      tags: tagRows.filter((t) => t.productId === p.id).map((t) => t.name),
      skus: vs.map((v) => v.sku).filter((s): s is string => !!s),
      options: [...new Set(vs.flatMap((v) => [v.o1, v.o2, v.o3]).filter((s): s is string => !!s))],
      description: htmlToText(p.descriptionHtml).slice(0, 5000),
      priceMin: p.priceMin,
      available: p.available,
      createdAt: p.createdAt.getTime(),
    };
  });
  const present = new Set(ids);
  const removed = productIds ? productIds.filter((id) => !present.has(id)) : [];
  return { docs, removed };
}

export async function meiliSearch(db: Db, opts: { url: string; apiKey?: string | undefined }): Promise<SearchEngine> {
  const { Meilisearch } = await import("meilisearch");
  const client = new Meilisearch({ host: opts.url, ...(opts.apiKey ? { apiKey: opts.apiKey } : {}) });
  const configured = new Set<string>();
  const uid = (storeId: string) => `products_${storeId.replace(/-/g, "")}`;

  async function index(storeId: string) {
    const name = uid(storeId);
    if (!configured.has(name)) {
      await client.createIndex(name, { primaryKey: "id" }).waitTask().catch(() => undefined);
      await client
        .index(name)
        .updateSettings({
          searchableAttributes: ["title", "vendor", "productType", "tags", "options", "skus", "description"],
          sortableAttributes: ["priceMin", "createdAt"],
          filterableAttributes: ["available", "vendor", "productType", "tags"],
        })
        .waitTask();
      configured.add(name);
    }
    return client.index<SearchDocument>(name);
  }

  return {
    id: "meilisearch",
    async search(storeId, q, { limit, offset }) {
      const res = await (await index(storeId)).search(q, { limit, offset, attributesToRetrieve: ["id"] });
      return { ids: res.hits.map((h) => h.id), total: res.estimatedTotalHits ?? res.hits.length };
    },
    async sync(storeId, productIds) {
      const { docs, removed } = await searchDocuments(db, storeId, productIds);
      const idx = await index(storeId);
      if (docs.length) await idx.addDocuments(docs).waitTask();
      if (removed.length) await idx.deleteDocuments(removed).waitTask();
    },
    async reindex(storeId) {
      const { docs } = await searchDocuments(db, storeId);
      const idx = await index(storeId);
      await idx.deleteAllDocuments().waitTask();
      for (let i = 0; i < docs.length; i += 1000) await idx.addDocuments(docs.slice(i, i + 1000)).waitTask();
      return docs.length;
    },
  };
}

/** The storefront's engine: Meilisearch when configured, else Postgres. */
export function searchEngine(deps: Pick<CoreDeps, "db" | "search">): SearchEngine {
  return deps.search ?? postgresSearch(deps.db);
}
