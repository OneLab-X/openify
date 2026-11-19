import { and, asc, eq, or, isNull, taxOverrides, taxRates, type Executor, type MailingAddress, type TaxLine } from "@shopkit/db";
import { z } from "zod";
import { writeAudit } from "../audit.js";
import type { Actor, CoreDeps } from "../deps.js";
import { notFound } from "../errors.js";
import type { SettingValue } from "../settings.js";
import { roundHalf } from "./discount-engine.js";

/**
 * Tax (Phase 4).
 * - India GST: one rate per line (store default, or a collection override such as 5% on apparel),
 *   split CGST+SGST when the place of supply is the store's registered state, IGST otherwise.
 *   Exports (shipping outside India) are zero-rated. HSN codes come from the variant.
 * - Generic VAT / sales tax: a rate per country with optional per-region rows (a region row
 *   replaces the country row). Stores with no rows use the default rate everywhere.
 * Rounding is per line, half away from zero; prices may include tax.
 */
export type TaxConfig = SettingValue<"tax.config">;


export function taxOn(base: number, rateBps: number, included: boolean): number {
  if (base <= 0 || rateBps <= 0) return 0;
  return roundHalf(included ? (base * rateBps) / (10_000 + rateBps) : (base * rateBps) / 10_000);
}

const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

export const isIntraState = (cfg: TaxConfig, address: Pick<MailingAddress, "country" | "province"> | null | undefined) =>
  !!address && !!cfg.registeredState && address.country === "IN" && norm(address.province) === norm(cfg.registeredState);

/** Names and splits one line's tax: CGST+SGST (floor/ceil halves) within the state, IGST across. */
export function splitTax(amount: number, rateBps: number, cfg: TaxConfig, address: MailingAddress | null | undefined, regionName?: string | null): TaxLine[] {
  if (amount === 0 || rateBps === 0) return [];
  if (cfg.mode === "india_gst") {
    if (address?.country === "IN" && cfg.registeredState) {
      if (isIntraState(cfg, address)) {
        const cgst = Math.floor(amount / 2);
        return [
          { title: "CGST", rateBps: rateBps / 2, amount: cgst },
          { title: "SGST", rateBps: rateBps / 2, amount: amount - cgst },
        ];
      }
      return [{ title: "IGST", rateBps, amount }];
    }
    return [{ title: "GST", rateBps, amount }];
  }
  return [{ title: regionName?.trim() || cfg.label?.trim() || "Tax", rateBps, amount }];
}

export function mergeTaxLines(lists: TaxLine[][]): TaxLine[] {
  const map = new Map<string, TaxLine>();
  for (const l of lists.flat()) {
    const key = `${l.title}:${l.rateBps}`;
    const prev = map.get(key);
    map.set(key, prev ? { ...prev, amount: prev.amount + l.amount } : { ...l });
  }
  return [...map.values()];
}

export interface TaxContext {
  cfg: TaxConfig;
  address: MailingAddress | null | undefined;
  /** Rate for items without an override, and its display name. */
  baseRateBps: number;
  baseName: string | null;
  overrides: { collectionId: string; rateBps: number; specificity: number }[];
}

/** Loads the rates that can apply to an address. */
export async function loadTaxContext(db: Executor, storeId: string, cfg: TaxConfig, address: MailingAddress | null | undefined): Promise<TaxContext> {
  const country = address?.country?.toUpperCase() ?? null;
  let baseRateBps = cfg.defaultRateBps;
  let baseName: string | null = null;
  if (cfg.mode === "india_gst") {
    // Exports are zero-rated; with no address yet, show the domestic rate.
    if (country && country !== "IN") baseRateBps = 0;
  } else {
    const rows = await db.select().from(taxRates).where(eq(taxRates.storeId, storeId));
    if (rows.length > 0) {
      const inCountry = rows.filter((r) => r.country.trim() === country);
      const region = inCountry.find((r) => r.province && norm(r.province) === norm(address?.province));
      const whole = inCountry.find((r) => !r.province);
      const hit = region ?? whole;
      if (country) {
        baseRateBps = hit?.rateBps ?? 0;
        baseName = hit?.name ?? null;
      }
    }
  }
  const overrideRows = await db
    .select()
    .from(taxOverrides)
    .where(and(eq(taxOverrides.storeId, storeId), country ? or(isNull(taxOverrides.country), eq(taxOverrides.country, country)) : isNull(taxOverrides.country)));
  const overrides = overrideRows
    .filter((o) => !o.province || norm(o.province) === norm(address?.province))
    .filter(() => !(cfg.mode === "india_gst" && country && country !== "IN"))
    .map((o) => ({ collectionId: o.collectionId, rateBps: o.rateBps, specificity: (o.country ? 1 : 0) + (o.province ? 1 : 0) }));
  return { cfg, address, baseRateBps, baseName, overrides };
}

/** The rate for a line: the most specific matching collection override (lowest rate on a tie), else the base rate. */
export function rateForLine(ctx: TaxContext, collectionIds: readonly string[]): number {
  const hits = ctx.overrides.filter((o) => collectionIds.includes(o.collectionId)).sort((a, b) => b.specificity - a.specificity || a.rateBps - b.rateBps);
  return hits[0]?.rateBps ?? ctx.baseRateBps;
}

// ── Admin CRUD ───────────────────────────────────────────────────────────────
export const taxRateInput = z.object({
  country: z.string().trim().toUpperCase().length(2),
  province: z.string().trim().max(100).nullish(),
  name: z.string().trim().min(1).max(60),
  rateBps: z.number().int().min(0).max(10_000),
});

export const taxOverrideInput = z.object({
  collectionId: z.uuid(),
  country: z.string().trim().toUpperCase().length(2).nullish(),
  province: z.string().trim().max(100).nullish(),
  rateBps: z.number().int().min(0).max(10_000),
});

export async function listTax(db: Executor, storeId: string) {
  const [rates, overrides] = await Promise.all([
    db.select().from(taxRates).where(eq(taxRates.storeId, storeId)).orderBy(asc(taxRates.country), asc(taxRates.province)),
    db.select().from(taxOverrides).where(eq(taxOverrides.storeId, storeId)).orderBy(asc(taxOverrides.createdAt)),
  ]);
  return {
    rates: rates.map((r) => ({ id: r.id, country: r.country.trim(), province: r.province, name: r.name, rateBps: r.rateBps })),
    overrides: overrides.map((o) => ({ id: o.id, collectionId: o.collectionId, country: o.country?.trim() ?? null, province: o.province, rateBps: o.rateBps })),
  };
}

export async function saveTaxRate(deps: CoreDeps, actor: Actor, storeId: string, input: z.input<typeof taxRateInput>, id?: string) {
  const d = taxRateInput.parse(input);
  const values = { ...d, province: d.province || null };
  return deps.db.transaction(async (tx) => {
    let rateId = id;
    if (id) {
      const [row] = await tx.update(taxRates).set(values).where(and(eq(taxRates.storeId, storeId), eq(taxRates.id, id))).returning({ id: taxRates.id });
      if (!row) throw notFound("Tax rate");
    } else {
      const [row] = await tx
        .insert(taxRates)
        .values({ storeId, ...values })
        .onConflictDoUpdate({ target: [taxRates.storeId, taxRates.country, taxRates.province], set: { name: values.name, rateBps: values.rateBps } })
        .returning({ id: taxRates.id });
      rateId = row!.id;
    }
    await writeAudit(tx, actor, { storeId, action: "tax_rate.saved", resourceType: "tax_rate", resourceId: rateId! });
    return rateId!;
  });
}

export async function deleteTaxRate(deps: CoreDeps, actor: Actor, storeId: string, id: string) {
  await deps.db.transaction(async (tx) => {
    const [row] = await tx.delete(taxRates).where(and(eq(taxRates.storeId, storeId), eq(taxRates.id, id))).returning({ id: taxRates.id });
    if (!row) throw notFound("Tax rate");
    await writeAudit(tx, actor, { storeId, action: "tax_rate.deleted", resourceType: "tax_rate", resourceId: id });
  });
}

export async function saveTaxOverride(deps: CoreDeps, actor: Actor, storeId: string, input: z.input<typeof taxOverrideInput>, id?: string) {
  const d = taxOverrideInput.parse(input);
  const values = { ...d, country: d.country || null, province: d.province || null };
  return deps.db.transaction(async (tx) => {
    let overrideId = id;
    if (id) {
      const [row] = await tx.update(taxOverrides).set(values).where(and(eq(taxOverrides.storeId, storeId), eq(taxOverrides.id, id))).returning({ id: taxOverrides.id });
      if (!row) throw notFound("Tax override");
    } else {
      const [row] = await tx.insert(taxOverrides).values({ storeId, ...values }).returning({ id: taxOverrides.id });
      overrideId = row!.id;
    }
    await writeAudit(tx, actor, { storeId, action: "tax_override.saved", resourceType: "tax_override", resourceId: overrideId! });
    return overrideId!;
  });
}

export async function deleteTaxOverride(deps: CoreDeps, actor: Actor, storeId: string, id: string) {
  await deps.db.transaction(async (tx) => {
    const [row] = await tx.delete(taxOverrides).where(and(eq(taxOverrides.storeId, storeId), eq(taxOverrides.id, id))).returning({ id: taxOverrides.id });
    if (!row) throw notFound("Tax override");
    await writeAudit(tx, actor, { storeId, action: "tax_override.deleted", resourceType: "tax_override", resourceId: id });
  });
}
