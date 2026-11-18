import { and, eq, settings, type Executor } from "@shopkit/db";
import { z } from "zod";

/** Typed settings (SPEC §8 `settings`). Each key has a zod schema; reads fall back to defaults. */
export const SETTINGS = {
  "storage.active": z.object({ provider: z.string(), mode: z.enum(["test", "live"]) }),
  "email.active": z.object({ provider: z.string(), mode: z.enum(["test", "live"]) }).nullable(),
  "analytics.consentBanner": z.boolean(),
  "payments.mode": z.enum(["test", "live"]),
  "shipping.defaults": z.object({
    zoneName: z.string(),
    countries: z.array(z.string().length(2)),
    rateName: z.string(),
    /** Flat rate in minor units of the store currency. */
    rateAmount: z.number().int().min(0),
    freeOver: z.number().int().min(0).nullable(),
  }),
  "tax.config": z.object({
    mode: z.enum(["india_gst", "generic"]),
    pricesIncludeTax: z.boolean(),
    /** Basis points, e.g. 1800 = 18%. */
    defaultRateBps: z.number().int().min(0).max(10_000),
    gstin: z.string().optional(),
    registeredState: z.string().optional(),
    label: z.string().optional(),
  }),
} as const;
export type SettingKey = keyof typeof SETTINGS;
export type SettingValue<K extends SettingKey> = z.infer<(typeof SETTINGS)[K]>;

export const SETTING_DEFAULTS: { [K in SettingKey]: SettingValue<K> } = {
  "storage.active": { provider: "local", mode: "live" },
  "email.active": null,
  "analytics.consentBanner": true,
  "payments.mode": "test",
  "shipping.defaults": { zoneName: "Domestic", countries: [], rateName: "Standard", rateAmount: 0, freeOver: null },
  "tax.config": { mode: "generic", pricesIncludeTax: false, defaultRateBps: 0 },
};

export async function getSetting<K extends SettingKey>(db: Executor, storeId: string, key: K): Promise<SettingValue<K>> {
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(and(eq(settings.storeId, storeId), eq(settings.key, key)));
  if (!row) return SETTING_DEFAULTS[key];
  const parsed = SETTINGS[key].safeParse(row.value);
  return parsed.success ? (parsed.data as SettingValue<K>) : SETTING_DEFAULTS[key];
}

export async function setSetting<K extends SettingKey>(db: Executor, storeId: string, key: K, value: SettingValue<K>): Promise<void> {
  const parsed = SETTINGS[key].parse(value);
  await db
    .insert(settings)
    .values({ storeId, key, value: parsed })
    .onConflictDoUpdate({ target: [settings.storeId, settings.key], set: { value: parsed, updatedAt: new Date() } });
}
