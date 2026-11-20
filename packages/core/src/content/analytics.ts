import { analyticsEvents, and, customers, eq, lt, orders, providerCredentials, refunds, type Executor } from "@shopkit/db";
import type { AnalyticsProvider, ServerEventName } from "@shopkit/providers";
import { z } from "zod";
import { loadProvider } from "../credentials.js";
import type { CoreDeps } from "../deps.js";
import { now } from "../deps.js";
import { dayInZone } from "../reports.js";
import { getSetting } from "../settings.js";
import { getStore } from "../stores.js";

/**
 * Analytics (SPEC §12). First-party events from the storefront (no cookies, no IP stored; a random
 * per-tab session id) feed `analytics_daily`. Third-party providers render their client snippets on
 * the storefront (consent-gated when they need it) and receive server-side purchase/refund events
 * from the worker.
 */
export const STOREFRONT_EVENTS = ["page_view", "view_item", "view_item_list", "add_to_cart", "begin_checkout", "purchase"] as const;

export const eventsInput = z.object({
  sessionId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  events: z
    .array(
      z.object({
        name: z.enum(STOREFRONT_EVENTS),
        path: z.string().max(500).optional(),
        data: z.record(z.string().max(40), z.union([z.string().max(200), z.number(), z.boolean(), z.null()])).optional(),
      }),
    )
    .min(1)
    .max(20),
});

export async function recordEvents(deps: CoreDeps, storeId: string, input: z.input<typeof eventsInput>) {
  const d = eventsInput.parse(input);
  const store = await getStore(deps.db, storeId);
  const day = dayInZone(now(deps), store.timezone || "UTC");
  await deps.db.insert(analyticsEvents).values(
    d.events.map((e) => ({
      storeId,
      sessionId: d.sessionId,
      name: e.name,
      path: e.path ? e.path.split(/[?#]/)[0]!.slice(0, 300) : null,
      day,
      data: Object.fromEntries(Object.entries(e.data ?? {}).slice(0, 12)),
    })),
  );
  return { accepted: d.events.length };
}

/** Raw events older than `days` are deleted (aggregates stay in analytics_daily). */
export async function pruneAnalyticsEvents(db: Executor, at: Date, days = 90) {
  const cutoff = new Date(at.getTime() - days * 86_400_000).toISOString().slice(0, 10);
  const rows = await db.delete(analyticsEvents).where(lt(analyticsEvents.day, cutoff)).returning({ id: analyticsEvents.id });
  return rows.length;
}

async function enabledAnalytics(deps: CoreDeps, storeId: string) {
  const rows = await deps.db
    .select({ provider: providerCredentials.provider, mode: providerCredentials.mode })
    .from(providerCredentials)
    .where(and(eq(providerCredentials.storeId, storeId), eq(providerCredentials.kind, "analytics"), eq(providerCredentials.enabled, true)));
  return rows;
}

export async function enabledAnalyticsProviders(deps: CoreDeps, storeId: string): Promise<string[]> {
  return [...new Set((await enabledAnalytics(deps, storeId)).map((r) => r.provider))];
}

/** Snippets for the storefront <head>, plus whether the consent banner is on. */
export async function analyticsConfig(deps: CoreDeps, storeId: string) {
  const out: { id: string; head: string; body: string; requiresConsent: boolean }[] = [];
  for (const row of await enabledAnalytics(deps, storeId)) {
    const p = await loadProvider(deps, { storeId, kind: "analytics", provider: row.provider, mode: row.mode }).catch(() => null);
    if (!p) continue;
    const s = p.clientSnippet();
    out.push({ id: row.provider, head: s.head ?? "", body: s.body ?? "", requiresConsent: s.requiresConsent });
  }
  const consentBanner = await getSetting(deps.db, storeId, "analytics.consentBanner");
  // Without a banner there is nobody to ask: consent-requiring snippets are left out entirely.
  return { consentBanner, providers: consentBanner ? out : out.filter((p) => !p.requiresConsent) };
}

/** Worker job: one provider, one server-side purchase/refund event. */
export async function sendServerAnalyticsEvent(deps: CoreDeps, storeId: string, providerId: string, event: ServerEventName, data: { orderId: string; refundId?: string }) {
  const rows = (await enabledAnalytics(deps, storeId)).filter((r) => r.provider === providerId);
  const row = rows.find((r) => r.mode === "live") ?? rows[0];
  if (!row) return { status: "skipped", reason: "provider disabled" };
  const p: AnalyticsProvider | null = await loadProvider(deps, { storeId, kind: "analytics", provider: providerId, mode: row.mode });
  if (!p?.serverEvent) return { status: "skipped", reason: "no server events" };
  const [o] = await deps.db.select().from(orders).where(and(eq(orders.storeId, storeId), eq(orders.id, data.orderId)));
  if (!o) return { status: "skipped", reason: "order not found" };
  let digits = 2;
  try {
    digits = new Intl.NumberFormat("en", { style: "currency", currency: o.currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    /* 2 */
  }
  let minor = o.total;
  if (event === "refund") {
    const [r] = data.refundId ? await deps.db.select({ amount: refunds.amount, status: refunds.status }).from(refunds).where(eq(refunds.id, data.refundId)) : [];
    if (r && r.status !== "success") throw new Error("refund not confirmed yet");
    minor = r?.amount ?? o.amountRefunded;
  }
  await p.serverEvent(event, {
    // The order id doubles as the client id: purchases from the same order deduplicate.
    clientId: o.id,
    orderId: o.name ?? o.id,
    value: minor / 10 ** digits,
    currency: o.currency,
    url: `${deps.runtime.publicUrl}/checkout`,
  });
  return { status: "sent", provider: providerId, event };
}

/** Newsletter signup: creates the customer if needed and records marketing consent. */
export const newsletterInput = z.object({ email: z.email().max(254) });
export async function subscribeNewsletter(deps: CoreDeps, storeId: string, input: z.input<typeof newsletterInput>) {
  const { email } = newsletterInput.parse(input);
  const at = now(deps);
  await deps.db
    .insert(customers)
    .values({ storeId, email: email.toLowerCase(), marketingConsent: true, marketingConsentAt: at })
    .onConflictDoUpdate({ target: [customers.storeId, customers.email], set: { marketingConsent: true, marketingConsentAt: at } });
  return { ok: true as const };
}
