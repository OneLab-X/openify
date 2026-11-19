import { and, eq, inArray, METAFIELD_TYPES, metafieldDefinitions, metafields, type Executor, type MetafieldType } from "@shopkit/db";
import { z } from "zod";
import { AppError } from "../errors.js";

type Owner = "product" | "variant" | "collection";

const ident = z
  .string()
  .trim()
  .regex(/^[a-z0-9_]{2,64}$/i, "2–64 letters, digits or underscores");

export const metafieldInput = z.object({
  namespace: ident,
  key: ident,
  type: z.enum(METAFIELD_TYPES),
  value: z.unknown(),
});
export type MetafieldInput = z.input<typeof metafieldInput>;

export const metafieldDefinitionInput = z.object({
  ownerType: z.enum(["product", "variant", "collection"]),
  namespace: ident,
  key: ident,
  name: z.string().trim().min(1).max(120),
  type: z.enum(METAFIELD_TYPES),
  description: z.string().trim().max(500).optional(),
});

const VALUE: Record<MetafieldType, z.ZodType> = {
  single_line_text: z.string().max(5000).refine((v) => !v.includes("\n"), "Single line only"),
  multi_line_text: z.string().max(65_000),
  number_integer: z.coerce.number().int().min(-9_007_199_254_740_991).max(9_007_199_254_740_991),
  number_decimal: z.coerce.number().finite(),
  boolean: z.union([z.boolean(), z.enum(["true", "false"]).transform((v) => v === "true")]),
  url: z.url().refine((u) => /^https?:\/\//.test(u), "Must be an http(s) URL"),
  date: z.iso.date(),
  json: z.unknown().refine((v) => JSON.stringify(v ?? null).length <= 65_000, "JSON is too large"),
};

/** Validates a value against its declared type; returns the normalised value stored in jsonb. */
export function parseMetafieldValue(type: MetafieldType, value: unknown, path = "value"): unknown {
  const parsed = VALUE[type].safeParse(value);
  if (!parsed.success) {
    throw new AppError("validation_failed", "Check the highlighted fields", [{ path, message: parsed.error.issues[0]?.message ?? "Invalid value" }]);
  }
  return parsed.data;
}

/** Replaces an owner's metafields with `input` (missing ones are deleted). */
export async function replaceMetafields(tx: Executor, storeId: string, ownerType: Owner, ownerId: string, input: MetafieldInput[]) {
  const seen = new Set<string>();
  const rows = input.map((raw, i) => {
    const m = metafieldInput.parse(raw);
    const id = `${m.namespace}.${m.key}`.toLowerCase();
    if (seen.has(id)) throw new AppError("validation_failed", `Duplicate metafield ${m.namespace}.${m.key}`);
    seen.add(id);
    return { storeId, ownerType, ownerId, namespace: m.namespace, key: m.key, type: m.type, value: parseMetafieldValue(m.type, m.value, `metafields.${i}.value`) as object };
  });
  await tx.delete(metafields).where(and(eq(metafields.ownerType, ownerType), eq(metafields.ownerId, ownerId)));
  if (rows.length) await tx.insert(metafields).values(rows);
}

export async function metafieldsFor(db: Executor, ownerType: Owner, ownerIds: string[]) {
  if (ownerIds.length === 0) return new Map<string, { namespace: string; key: string; type: MetafieldType; value: unknown }[]>();
  const rows = await db
    .select()
    .from(metafields)
    .where(and(eq(metafields.ownerType, ownerType), inArray(metafields.ownerId, ownerIds)))
    .orderBy(metafields.namespace, metafields.key);
  const out = new Map<string, { namespace: string; key: string; type: MetafieldType; value: unknown }[]>();
  for (const r of rows) {
    const list = out.get(r.ownerId) ?? [];
    list.push({ namespace: r.namespace, key: r.key, type: r.type, value: r.value });
    out.set(r.ownerId, list);
  }
  return out;
}

export async function listMetafieldDefinitions(db: Executor, storeId: string, ownerType?: Owner) {
  return db
    .select()
    .from(metafieldDefinitions)
    .where(and(eq(metafieldDefinitions.storeId, storeId), ownerType ? eq(metafieldDefinitions.ownerType, ownerType) : undefined))
    .orderBy(metafieldDefinitions.namespace, metafieldDefinitions.key);
}

export async function createMetafieldDefinition(db: Executor, storeId: string, input: z.input<typeof metafieldDefinitionInput>) {
  const data = metafieldDefinitionInput.parse(input);
  const [row] = await db.insert(metafieldDefinitions).values({ storeId, ...data }).onConflictDoNothing().returning();
  if (!row) throw new AppError("conflict", `${data.namespace}.${data.key} is already defined`);
  return row;
}

export async function deleteMetafieldDefinition(db: Executor, storeId: string, id: string) {
  await db.delete(metafieldDefinitions).where(and(eq(metafieldDefinitions.storeId, storeId), eq(metafieldDefinitions.id, id)));
}
