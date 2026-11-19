import { sql, type SQL } from "@shopkit/db";
import type { CollectionRule, CollectionRules } from "@shopkit/db";
import { z } from "zod";

/**
 * Smart-collection rules (Shopify parity): tag, title, type, vendor, variant price, compare-at price
 * and inventory, combined with all/any. Money values are integer minor units.
 */
const TEXT_RELATIONS = ["equals", "not_equals", "starts_with", "ends_with", "contains", "not_contains"] as const;
const NUMBER_RELATIONS = ["equals", "not_equals", "greater_than", "less_than"] as const;

const textRule = (field: "title" | "type" | "vendor") =>
  z.object({ field: z.literal(field), relation: z.enum(TEXT_RELATIONS), value: z.string().trim().min(1).max(255) });
const numberRule = (field: "price" | "compare_at_price" | "inventory") =>
  z.object({ field: z.literal(field), relation: z.enum(NUMBER_RELATIONS), value: z.string().trim().regex(/^-?\d{1,15}$/, "Whole number") });

export const collectionRuleSchema = z.discriminatedUnion("field", [
  z.object({ field: z.literal("tag"), relation: z.enum(["equals", "not_equals"]), value: z.string().trim().min(1).max(255) }),
  textRule("title"),
  textRule("type"),
  textRule("vendor"),
  numberRule("price"),
  numberRule("compare_at_price"),
  numberRule("inventory"),
]);

export const collectionRulesSchema = z.object({
  match: z.enum(["all", "any"]).default("all"),
  conditions: z.array(collectionRuleSchema).min(1).max(60),
});

const escapeLike = (v: string) => v.replace(/[\\%_]/g, "\\$&");

function textCondition(column: SQL, relation: CollectionRule["relation"], value: string): SQL {
  const v = escapeLike(value);
  switch (relation) {
    case "equals":
      return sql`lower(coalesce(${column}, '')) = lower(${value})`;
    case "not_equals":
      return sql`lower(coalesce(${column}, '')) <> lower(${value})`;
    case "starts_with":
      return sql`coalesce(${column}, '') ilike ${`${v}%`}`;
    case "ends_with":
      return sql`coalesce(${column}, '') ilike ${`%${v}`}`;
    case "contains":
      return sql`coalesce(${column}, '') ilike ${`%${v}%`}`;
    case "not_contains":
      return sql`coalesce(${column}, '') not ilike ${`%${v}%`}`;
    default:
      return sql`false`;
  }
}

function compare(relation: CollectionRule["relation"]): SQL {
  return relation === "greater_than" ? sql`>` : relation === "less_than" ? sql`<` : relation === "not_equals" ? sql`<>` : sql`=`;
}

/** SQL predicate over a `products` row aliased `p`. */
export function ruleCondition(rule: CollectionRule): SQL {
  switch (rule.field) {
    case "tag": {
      const has = sql`exists (select 1 from product_tags pt join tags t on t.id = pt.tag_id where pt.product_id = p.id and t.name = ${rule.value})`;
      return rule.relation === "not_equals" ? sql`not ${has}` : has;
    }
    case "title":
      return textCondition(sql`p.title`, rule.relation, rule.value);
    case "type":
      return textCondition(sql`p.product_type`, rule.relation, rule.value);
    case "vendor":
      return textCondition(sql`p.vendor`, rule.relation, rule.value);
    case "price":
      return sql`exists (select 1 from product_variants v where v.product_id = p.id and v.price ${compare(rule.relation)} ${Number(rule.value)})`;
    case "compare_at_price":
      return sql`exists (select 1 from product_variants v where v.product_id = p.id and v.compare_at_price ${compare(rule.relation)} ${Number(rule.value)})`;
    case "inventory":
      return sql`p.total_inventory ${compare(rule.relation)} ${Number(rule.value)}`;
    default:
      return sql`false`;
  }
}

export function rulesCondition(rules: CollectionRules): SQL {
  if (rules.conditions.length === 0) return sql`false`;
  const parts = rules.conditions.map((r) => sql`(${ruleCondition(r)})`);
  return sql`(${sql.join(parts, rules.match === "any" ? sql` or ` : sql` and `)})`;
}
