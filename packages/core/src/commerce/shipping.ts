import {
  and,
  asc,
  eq,
  inArray,
  isNull,
  locations,
  or,
  shippingRates,
  shippingZoneCountries,
  shippingZones,
  type Executor,
  type MailingAddress,
} from "@shopkit/db";
import type { RateRequest, ShipmentParty } from "@shopkit/providers";
import { z } from "zod";
import { writeAudit } from "../audit.js";
import { loadProvider } from "../credentials.js";
import type { Actor, CoreDeps } from "../deps.js";
import { notFound } from "../errors.js";
import { getSetting } from "../settings.js";
import { getStore } from "../stores.js";

/**
 * Shipping zones and rates (Phase 4). A zone covers countries, optionally narrowed to states and
 * postal-code (PIN) prefixes; the most specific zone for the address wins. Rates: flat, by weight,
 * by price, carrier-calculated, local delivery by PIN prefix, and local pickup at a location; any
 * rate can be free over an amount. Stores with no zones fall back to `shipping.defaults` (setup).
 */
const countryCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^([A-Z]{2}|\*)$/, "Use a 2-letter country code or * for rest of world");

export const zoneInput = z.object({
  name: z.string().trim().min(1).max(100),
  countries: z
    .array(
      z.object({
        country: countryCode,
        provinces: z.array(z.string().trim().min(1).max(100)).max(100).default([]),
        postalPrefixes: z.array(z.string().trim().regex(/^[A-Za-z0-9 ]{1,10}$/)).max(500).default([]),
      }),
    )
    .min(1)
    .max(250),
  position: z.number().int().min(0).default(0),
});

export const rateInput = z
  .object({
    zoneId: z.uuid().nullable().default(null),
    name: z.string().trim().min(1).max(100),
    description: z.string().trim().max(300).nullish(),
    kind: z.enum(["flat", "weight", "price", "carrier", "local_pickup", "local_delivery"]),
    amount: z.number().int().min(0).default(0),
    minValue: z.number().int().min(0).nullable().default(null),
    maxValue: z.number().int().min(1).nullable().default(null),
    freeOver: z.number().int().min(0).nullable().default(null),
    postalPrefixes: z.array(z.string().trim().regex(/^[A-Za-z0-9 ]{1,10}$/)).max(1000).default([]),
    locationId: z.uuid().nullable().default(null),
    provider: z.string().max(50).nullable().default(null),
    active: z.boolean().default(true),
    position: z.number().int().min(0).default(0),
  })
  .refine((r) => r.kind === "local_pickup" || r.kind === "local_delivery" || !!r.zoneId, { message: "Choose a zone", path: ["zoneId"] })
  .refine((r) => r.kind !== "local_pickup" || !!r.locationId, { message: "Choose the pickup location", path: ["locationId"] })
  .refine((r) => r.kind !== "local_delivery" || r.postalPrefixes.length > 0, { message: "Enter the PIN codes or prefixes you deliver to", path: ["postalPrefixes"] })
  .refine((r) => r.kind !== "carrier" || !!r.provider, { message: "Choose a carrier", path: ["provider"] })
  .refine((r) => r.minValue === null || r.maxValue === null || r.maxValue > r.minValue, { message: "Maximum must be above minimum", path: ["maxValue"] });

export async function listShipping(db: Executor, storeId: string) {
  const [zones, countries, rates] = await Promise.all([
    db.select().from(shippingZones).where(eq(shippingZones.storeId, storeId)).orderBy(asc(shippingZones.position), asc(shippingZones.createdAt)),
    db.select().from(shippingZoneCountries).where(eq(shippingZoneCountries.storeId, storeId)),
    db.select().from(shippingRates).where(eq(shippingRates.storeId, storeId)).orderBy(asc(shippingRates.position), asc(shippingRates.createdAt), asc(shippingRates.id)),
  ]);
  const rateView = (r: (typeof rates)[number]) => ({
    id: r.id,
    zoneId: r.zoneId,
    name: r.name,
    description: r.description,
    kind: r.kind,
    amount: r.amount,
    minValue: r.minValue,
    maxValue: r.maxValue,
    freeOver: r.freeOver,
    postalPrefixes: r.postalPrefixes,
    locationId: r.locationId,
    provider: r.provider,
    active: r.active,
    position: r.position,
  });
  return {
    zones: zones.map((z) => ({
      id: z.id,
      name: z.name,
      position: z.position,
      countries: countries.filter((c) => c.zoneId === z.id).map((c) => ({ country: c.country.trim(), provinces: c.provinces, postalPrefixes: c.postalPrefixes })),
      rates: rates.filter((r) => r.zoneId === z.id).map(rateView),
    })),
    localRates: rates.filter((r) => r.zoneId === null).map(rateView),
  };
}

export async function saveZone(deps: CoreDeps, actor: Actor, storeId: string, input: z.input<typeof zoneInput>, id?: string) {
  const data = zoneInput.parse(input);
  return deps.db.transaction(async (tx) => {
    let zoneId = id;
    if (id) {
      const [row] = await tx.update(shippingZones).set({ name: data.name, position: data.position }).where(and(eq(shippingZones.storeId, storeId), eq(shippingZones.id, id))).returning({ id: shippingZones.id });
      if (!row) throw notFound("Shipping zone");
      await tx.delete(shippingZoneCountries).where(eq(shippingZoneCountries.zoneId, id));
    } else {
      const [row] = await tx.insert(shippingZones).values({ storeId, name: data.name, position: data.position }).returning({ id: shippingZones.id });
      zoneId = row!.id;
    }
    await tx.insert(shippingZoneCountries).values(
      data.countries.map((c) => ({ storeId, zoneId: zoneId!, country: c.country, provinces: c.provinces, postalPrefixes: c.postalPrefixes.map((p) => p.replace(/\s+/g, "").toUpperCase()) })),
    );
    await writeAudit(tx, actor, { storeId, action: id ? "shipping_zone.updated" : "shipping_zone.created", resourceType: "shipping_zone", resourceId: zoneId! });
    return zoneId!;
  });
}

export async function deleteZone(deps: CoreDeps, actor: Actor, storeId: string, id: string) {
  await deps.db.transaction(async (tx) => {
    const [row] = await tx.delete(shippingZones).where(and(eq(shippingZones.storeId, storeId), eq(shippingZones.id, id))).returning({ id: shippingZones.id });
    if (!row) throw notFound("Shipping zone");
    await writeAudit(tx, actor, { storeId, action: "shipping_zone.deleted", resourceType: "shipping_zone", resourceId: id });
  });
}

export async function saveRate(deps: CoreDeps, actor: Actor, storeId: string, input: z.input<typeof rateInput>, id?: string) {
  const data = rateInput.parse(input);
  const values = { ...data, description: data.description ?? null, postalPrefixes: data.postalPrefixes.map((p) => p.replace(/\s+/g, "").toUpperCase()) };
  return deps.db.transaction(async (tx) => {
    if (data.zoneId) {
      const [z] = await tx.select({ id: shippingZones.id }).from(shippingZones).where(and(eq(shippingZones.storeId, storeId), eq(shippingZones.id, data.zoneId)));
      if (!z) throw notFound("Shipping zone");
    }
    let rateId = id;
    if (id) {
      const [row] = await tx.update(shippingRates).set(values).where(and(eq(shippingRates.storeId, storeId), eq(shippingRates.id, id))).returning({ id: shippingRates.id });
      if (!row) throw notFound("Shipping rate");
    } else {
      const [row] = await tx.insert(shippingRates).values({ storeId, ...values }).returning({ id: shippingRates.id });
      rateId = row!.id;
    }
    await writeAudit(tx, actor, { storeId, action: id ? "shipping_rate.updated" : "shipping_rate.created", resourceType: "shipping_rate", resourceId: rateId! });
    return rateId!;
  });
}

export async function deleteRate(deps: CoreDeps, actor: Actor, storeId: string, id: string) {
  await deps.db.transaction(async (tx) => {
    const [row] = await tx.delete(shippingRates).where(and(eq(shippingRates.storeId, storeId), eq(shippingRates.id, id))).returning({ id: shippingRates.id });
    if (!row) throw notFound("Shipping rate");
    await writeAudit(tx, actor, { storeId, action: "shipping_rate.deleted", resourceType: "shipping_rate", resourceId: id });
  });
}

// ── Quoting ──────────────────────────────────────────────────────────────────
const norm = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();
const pin = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, "").toUpperCase();

/** Score of a zone-country row for an address (0 = no match). Higher = more specific. */
export function zoneMatchScore(row: { country: string; provinces: readonly string[]; postalPrefixes: readonly string[] }, address: Pick<MailingAddress, "country" | "province" | "postalCode">): number {
  const country = row.country.trim().toUpperCase();
  if (country !== "*" && country !== address.country.toUpperCase()) return 0;
  let score = country === "*" ? 1 : 10;
  if (row.provinces.length) {
    if (!row.provinces.some((p) => norm(p) === norm(address.province))) return 0;
    score += 10;
  }
  if (row.postalPrefixes.length) {
    const code = pin(address.postalCode);
    const best = Math.max(0, ...row.postalPrefixes.filter((p) => code.startsWith(pin(p))).map((p) => pin(p).length));
    if (best === 0) return 0;
    score += 20 + best;
  }
  return score;
}

export const toGrams = (weight: number | null, unit: "kg" | "g" | "lb" | "oz") =>
  weight === null ? 0 : Math.round(weight * (unit === "kg" ? 1000 : unit === "g" ? 1 : unit === "lb" ? 453.592 : 28.3495));

export interface ShippingQuoteInput {
  address: MailingAddress | null | undefined;
  /** Discounted subtotal of shippable items (minor units). */
  subtotal: number;
  weightGrams: number;
  currency: string;
  /** Needed for carrier-calculated rates. */
  deps?: CoreDeps;
}

export interface ShippingOption {
  id: string;
  title: string;
  amount: number;
  kind: "flat" | "weight" | "price" | "carrier" | "local_pickup" | "local_delivery" | "legacy";
  description?: string | null;
  /** Carrier rate chosen at checkout, kept for creating the shipment later. */
  carrierRateId?: string | null;
  provider?: string | null;
}

export async function shipmentOrigin(db: Executor, storeId: string, locationId?: string | null): Promise<ShipmentParty> {
  const store = await getStore(db, storeId);
  const [loc] = locationId ? await db.select().from(locations).where(eq(locations.id, locationId)) : [];
  const a = (loc?.address && Object.keys(loc.address).length ? loc.address : store.address) ?? {};
  return { name: store.name, phone: store.phone ?? null, email: store.email ?? null, line1: a.line1 ?? "", line2: a.line2 ?? null, city: a.city ?? "", province: a.province ?? null, postalCode: a.postalCode ?? "", country: a.country ?? store.country ?? "IN" };
}

export const partyFromAddress = (a: MailingAddress, email?: string | null): ShipmentParty => ({
  name: [a.firstName, a.lastName].filter(Boolean).join(" ") || "Customer",
  company: a.company ?? null,
  phone: a.phone ?? null,
  email: email ?? null,
  line1: a.line1,
  line2: a.line2 ?? null,
  city: a.city,
  province: a.province ?? null,
  postalCode: a.postalCode ?? "",
  country: a.country,
});

/**
 * Rates offered for an address. Carrier rates are fetched live (failures are skipped, so a carrier
 * outage never blocks checkout as long as another rate exists).
 */
export async function quoteShipping(db: Executor, storeId: string, input: ShippingQuoteInput): Promise<{ options: ShippingOption[]; zoned: boolean; ships: boolean }> {
  const zones = await db.select({ id: shippingZones.id }).from(shippingZones).where(eq(shippingZones.storeId, storeId)).limit(1);
  const localRates = await db
    .select()
    .from(shippingRates)
    .where(and(eq(shippingRates.storeId, storeId), isNull(shippingRates.zoneId), eq(shippingRates.active, true)))
    .orderBy(asc(shippingRates.position), asc(shippingRates.createdAt), asc(shippingRates.id));
  if (zones.length === 0 && localRates.length === 0) {
    // Setup's single flat rate (Phase 3 behaviour).
    const cfg = await getSetting(db, storeId, "shipping.defaults");
    const country = input.address?.country?.toUpperCase();
    const ships = cfg.countries.length === 0 || !country || cfg.countries.includes(country);
    if (!ships) return { options: [], zoned: false, ships: false };
    const free = cfg.freeOver !== null && input.subtotal >= cfg.freeOver;
    return { options: [{ id: "standard", title: cfg.rateName || "Standard", amount: free ? 0 : cfg.rateAmount, kind: "legacy" }], zoned: false, ships: true };
  }

  const options: ShippingOption[] = [];
  const address = input.address;
  const freeIf = (r: { freeOver: number | null; amount: number }) => (r.freeOver !== null && input.subtotal >= r.freeOver ? 0 : r.amount);

  // Local pickup is always offered; local delivery when the PIN matches.
  for (const r of localRates) {
    if (r.kind === "local_pickup") options.push({ id: r.id, title: r.name, amount: freeIf(r), kind: r.kind, description: r.description });
    else if (r.kind === "local_delivery" && address && r.postalPrefixes.some((p) => pin(address.postalCode).startsWith(pin(p)))) {
      options.push({ id: r.id, title: r.name, amount: freeIf(r), kind: r.kind, description: r.description });
    }
  }

  if (!address) return { options, zoned: true, ships: true };
  const rows = await db.select().from(shippingZoneCountries).where(and(eq(shippingZoneCountries.storeId, storeId), or(eq(shippingZoneCountries.country, address.country.toUpperCase()), eq(shippingZoneCountries.country, "*"))));
  const best = rows.map((r) => ({ r, score: zoneMatchScore(r, address) })).filter((x) => x.score > 0).sort((a, b) => b.score - a.score)[0];
  if (best) {
    const rates = await db
      .select()
      .from(shippingRates)
      .where(and(eq(shippingRates.zoneId, best.r.zoneId), eq(shippingRates.active, true), inArray(shippingRates.kind, ["flat", "weight", "price", "carrier", "local_delivery"])))
      .orderBy(asc(shippingRates.position), asc(shippingRates.createdAt), asc(shippingRates.id));
    for (const r of rates) {
      const within = (v: number) => (r.minValue === null || v >= r.minValue) && (r.maxValue === null || v < r.maxValue);
      if (r.kind === "flat") options.push({ id: r.id, title: r.name, amount: freeIf(r), kind: r.kind, description: r.description });
      else if (r.kind === "weight" && within(input.weightGrams)) options.push({ id: r.id, title: r.name, amount: freeIf(r), kind: r.kind, description: r.description });
      else if (r.kind === "price" && within(input.subtotal)) options.push({ id: r.id, title: r.name, amount: freeIf(r), kind: r.kind, description: r.description });
      else if (r.kind === "local_delivery" && r.postalPrefixes.some((p) => pin(address.postalCode).startsWith(pin(p)))) options.push({ id: r.id, title: r.name, amount: freeIf(r), kind: r.kind, description: r.description });
      else if (r.kind === "carrier" && input.deps && r.provider) {
        try {
          const mode = (await getSetting(db, storeId, "payments.mode")) === "live" ? "live" : "test";
          const provider = (await loadProvider(input.deps, { storeId, kind: "shipping", provider: r.provider, mode })) ?? (await loadProvider(input.deps, { storeId, kind: "shipping", provider: r.provider, mode: "live" }));
          if (!provider) continue;
          const request: RateRequest = { from: await shipmentOrigin(db, storeId), to: partyFromAddress(address), parcel: { weightGrams: Math.max(input.weightGrams, 100) }, declaredValue: input.subtotal, currency: input.currency };
          const quotes = (await provider.rates(request)).filter((q) => q.currency === input.currency);
          const cheapest = [...quotes].sort((a, b) => a.amount - b.amount)[0];
          if (cheapest) {
            const free = r.freeOver !== null && input.subtotal >= r.freeOver;
            options.push({ id: r.id, title: r.name || cheapest.name, amount: free ? 0 : cheapest.amount + r.amount, kind: "carrier", description: cheapest.etaDays ? `${cheapest.etaDays} days` : r.description, carrierRateId: cheapest.id, provider: r.provider });
          }
        } catch (err) {
          input.deps.logger.warn({ err, provider: r.provider }, "carrier rate lookup failed");
        }
      }
    }
  }
  const ships = options.some((o) => o.kind !== "local_pickup") || !!best;
  return { options, zoned: true, ships };
}
