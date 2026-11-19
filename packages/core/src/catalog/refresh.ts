import { and, collections, eq, sql, type CollectionRules, type Executor } from "@shopkit/db";
import { rulesCondition } from "./rules.js";

const idArray = (ids: string[]) => sql`array[${sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `)}]`;

/**
 * Recomputes everything denormalised about products after any write: price range, availability,
 * total inventory, the search vector, and smart-collection membership. Runs in the caller's
 * transaction so readers never see a half-updated product.
 */
export async function refreshProducts(tx: Executor, storeId: string, productIds: string[]): Promise<void> {
  const ids = [...new Set(productIds)];
  if (ids.length === 0) return;
  const list = idArray(ids);

  await tx.execute(sql`
    with v as (
      select pv.product_id,
             min(pv.price) as pmin, max(pv.price) as pmax, max(pv.compare_at_price) as cap,
             bool_or(coalesce(not ii.tracked, true) or pv.inventory_policy = 'continue' or coalesce(lv.avail, 0) > 0) as avail,
             coalesce(sum(case when ii.tracked then coalesce(lv.avail, 0) else 0 end), 0)::int as total
      from product_variants pv
      left join inventory_items ii on ii.variant_id = pv.id
      left join (select inventory_item_id, sum(available) as avail from inventory_levels group by inventory_item_id) lv
             on lv.inventory_item_id = ii.id
      where pv.product_id = any(${list})
      group by pv.product_id
    )
    update products p set
      price_min = coalesce(v.pmin, 0), price_max = coalesce(v.pmax, 0), compare_at_price_max = v.cap,
      available = coalesce(v.avail, false), total_inventory = coalesce(v.total, 0)
    from (select unnest(${list}) as id) ids
    left join v on v.product_id = ids.id
    where p.id = ids.id and p.store_id = ${storeId}`);

  await tx.execute(sql`
    update products p set search_vector =
      setweight(to_tsvector('simple', coalesce(p.title, '')), 'A') ||
      setweight(to_tsvector('simple',
        coalesce(p.vendor, '') || ' ' || coalesce(p.product_type, '') || ' ' ||
        coalesce((select string_agg(t.name, ' ') from product_tags pt join tags t on t.id = pt.tag_id where pt.product_id = p.id), '') || ' ' ||
        coalesce((select string_agg(concat_ws(' ', v.sku, v.barcode, v.option1, v.option2, v.option3), ' ') from product_variants v where v.product_id = p.id), '')
      ), 'B') ||
      setweight(to_tsvector('simple', left(regexp_replace(p.description_html, '<[^>]+>', ' ', 'g'), 20000)), 'C')
    where p.id = any(${list}) and p.store_id = ${storeId}`);

  const smart = await tx
    .select({ id: collections.id, rules: collections.rules })
    .from(collections)
    .where(and(eq(collections.storeId, storeId), eq(collections.type, "smart")));
  for (const c of smart) await syncSmartCollection(tx, storeId, c.id, c.rules, ids);
}

/**
 * Materialises smart-collection membership. With `productIds`, only those products are re-evaluated
 * (after a product write); without, the whole collection is rebuilt (after a rule change).
 */
export async function syncSmartCollection(
  tx: Executor,
  storeId: string,
  collectionId: string,
  rules: CollectionRules | null,
  productIds?: string[],
): Promise<void> {
  const match = rules ? rulesCondition(rules) : sql`false`;
  const scope = productIds ? sql`and p.id = any(${idArray(productIds)})` : sql``;
  await tx.execute(sql`
    delete from collection_products cp
    using products p
    where cp.collection_id = ${collectionId} and p.id = cp.product_id ${scope} and not ${match}`);
  await tx.execute(sql`
    insert into collection_products (store_id, collection_id, product_id, position)
    select ${storeId}, ${collectionId}, p.id, 0 from products p
    where p.store_id = ${storeId} ${scope} and ${match}
    on conflict do nothing`);
  await updateCollectionCount(tx, collectionId);
}

export async function updateCollectionCount(tx: Executor, collectionId: string): Promise<void> {
  await tx.execute(sql`
    update collections set products_count = (select count(*) from collection_products where collection_id = ${collectionId})
    where id = ${collectionId}`);
}
