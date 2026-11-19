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
    /** Charge tax on shipping too (GST does; many US states do not). */
    taxShipping: z.boolean().optional(),
  }),
  "checkout.config": z.object({
    /** Minutes an unpaid order holds its inventory before the release job returns it. */
    reservationMinutes: z.number().int().min(5).max(7 * 24 * 60),
    /** Order name prefix, e.g. "#" → #1001 or "PLS-" → PLS-1001. */
    orderPrefix: z.string().max(10),
    requirePhone: z.boolean(),
    /** How customers sign in: one-time code by email (default) or a password. */
    customerAuth: z.enum(["otp", "password"]),
  }),
  "notifications.config": z.object({
    abandonedCheckoutEnabled: z.boolean(),
    abandonedCheckoutDelayMinutes: z.number().int().min(1).max(7 * 24 * 60),
    /** Staff addresses for new/paid order alerts; empty = the store email. */
    merchantEmails: z.array(z.email()).max(10),
    alertNewOrder: z.boolean(),
    alertPaidOrder: z.boolean(),
  }),
  /** Staff security (Phase 4): require every staff member to use two-factor sign-in. */
  "security.config": z.object({ requireTwoFactor: z.boolean() }),
  /** Per-template overrides edited in Settings → Notifications. */
  "notifications.templates": z.record(
    z.string(),
    z.object({ subject: z.string().max(200).optional(), intro: z.string().max(2000).optional(), enabled: z.boolean().optional() }),
  ),
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
  "checkout.config": { reservationMinutes: 30, orderPrefix: "#", requirePhone: false, customerAuth: "otp" },
  "notifications.config": { abandonedCheckoutEnabled: true, abandonedCheckoutDelayMinutes: 60, merchantEmails: [], alertNewOrder: true, alertPaidOrder: true },
  "notifications.templates": {},
  "security.config": { requireTwoFactor: false },
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
