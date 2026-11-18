import { eq, media, stores, type Executor } from "@shopkit/db";
import { z } from "zod";
import type { CoreDeps } from "./deps.js";
import { notFound } from "./errors.js";

/** Accepts IANA names including aliases ICU does not list canonically (e.g. Asia/Kolkata). */
function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const hex = z.string().regex(/^#[0-9a-f]{6}$/i, "Use a hex colour like #1f2937");

export const addressSchema = z.object({
  line1: z.string().max(200).optional(),
  line2: z.string().max(200).optional(),
  city: z.string().max(100).optional(),
  province: z.string().max(100).optional(),
  postalCode: z.string().max(20).optional(),
  country: z.string().length(2).toUpperCase().optional(),
});

export const storeDetailsSchema = z.object({
  name: z.string().trim().min(1).max(120),
  legalName: z.string().trim().max(200).optional(),
  email: z.email(),
  phone: z.string().trim().max(40).optional(),
  address: addressSchema.default({}),
  country: z.string().length(2).toUpperCase(),
  currency: z.string().length(3).toUpperCase(),
  timezone: z.string().max(64).refine(isTimeZone, "Unknown time zone"),
  locale: z.string().regex(/^[a-z]{2,3}(-[A-Z]{2})?$/, "Locale like en-IN"),
  weightUnit: z.enum(["kg", "g", "lb", "oz"]),
  brand: z.object({ primaryColor: hex.optional(), accentColor: hex.optional() }).default({}),
  publicUrl: z.url().refine((u) => /^https?:\/\//.test(u), "Must be an http(s) URL"),
});
export type StoreDetails = z.infer<typeof storeDetailsSchema>;

type StoreRow = typeof stores.$inferSelect;
type MediaRow = typeof media.$inferSelect;

export async function getStore(db: Executor, storeId: string): Promise<StoreRow> {
  const [row] = await db.select().from(stores).where(eq(stores.id, storeId));
  if (!row) throw notFound("Store");
  return row;
}

/** The single store of this install (SPEC §1: single store per install, multi-store ready). */
export async function getInstallStore(db: Executor): Promise<StoreRow | null> {
  const [row] = await db.select().from(stores).orderBy(stores.createdAt).limit(1);
  return row ?? null;
}

export function mediaUrl(deps: Pick<CoreDeps, "runtime">, m: Pick<MediaRow, "id" | "filename">): string {
  return `${deps.runtime.publicUrl}/media/${m.id}/${encodeURIComponent(m.filename)}`;
}

async function mediaById(db: Executor, id: string | null) {
  if (!id) return null;
  const [row] = await db.select().from(media).where(eq(media.id, id));
  return row ?? null;
}

export async function storeView(deps: CoreDeps, store: StoreRow) {
  const [logo, favicon] = await Promise.all([mediaById(deps.db, store.logoMediaId), mediaById(deps.db, store.faviconMediaId)]);
  return {
    id: store.id,
    status: store.status,
    name: store.name,
    legalName: store.legalName,
    email: store.email,
    phone: store.phone,
    address: store.address,
    country: store.country,
    currency: store.currency,
    timezone: store.timezone,
    locale: store.locale,
    weightUnit: store.weightUnit,
    brand: store.brand,
    publicUrl: store.publicUrl,
    logoUrl: logo ? mediaUrl(deps, logo) : null,
    faviconUrl: favicon ? mediaUrl(deps, favicon) : null,
    launchedAt: store.launchedAt?.toISOString() ?? null,
  };
}
export type StoreView = Awaited<ReturnType<typeof storeView>>;

export async function updateStoreDetails(db: Executor, storeId: string, details: StoreDetails): Promise<void> {
  await db
    .update(stores)
    .set({ ...details, legalName: details.legalName ?? null, phone: details.phone ?? null })
    .where(eq(stores.id, storeId));
}
