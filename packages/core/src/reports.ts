import { analyticsDaily, and, cartLines, checkouts, eq, gte, lte, orders, sql, type Executor } from "@shopkit/db";
import { z } from "zod";
import { getStore } from "./stores.js";

/**
 * Dashboard and reports (Phase 4). Sales figures come from placed orders (Shopify's definitions:
 * gross sales = line prices × quantities, net sales = gross − discounts − returns, total sales =
 * net + shipping + taxes); the conversion funnel comes from `analytics_daily` (SPEC §12), which
 * the worker rolls up from first-party data. Days are in the store's timezone.
 */
export const reportQuery = z.object({
  from: z.iso.date(),
  to: z.iso.date(),
  compare: z.enum(["none", "previous_period", "previous_year"]).default("previous_period"),
});
export type ReportQuery = z.input<typeof reportQuery>;

const DAY = 86_400_000;
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / DAY);

export function comparisonRange(q: { from: string; to: string; compare: "none" | "previous_period" | "previous_year" }): { from: string; to: string } | null {
  if (q.compare === "none") return null;
  if (q.compare === "previous_year") return { from: addDays(q.from, -365), to: addDays(q.to, -365) };
  const len = daysBetween(q.from, q.to) + 1;
  return { from: addDays(q.from, -len), to: addDays(q.from, -1) };
}

async function tzOf(db: Executor, storeId: string) {
  const store = await getStore(db, storeId);
  return { tz: store.timezone || "UTC", currency: store.currency ?? "USD" };
}

/** placed_at falls on [from, to] in the store timezone. */
const placedIn = (tz: string, from: string, to: string, column = sql.raw("o.placed_at")) =>
  sql`(${column} at time zone ${tz})::date between ${from}::date and ${to}::date`;

export interface SalesSummary {
  orders: number;
  grossSales: number;
  discounts: number;
  returns: number;
  netSales: number;
  shipping: number;
  taxes: number;
  totalSales: number;
  averageOrderValue: number;
  customers: number;
  returningCustomers: number;
  returningCustomerRate: number;
  unitsSold: number;
}

async function summary(db: Executor, storeId: string, tz: string, from: string, to: string): Promise<SalesSummary> {
  const { rows } = await db.execute<Record<string, string | number | null>>(sql`
    with o as (
      select o.* from ${orders} o
      where o.store_id = ${storeId} and o.placed_at is not null
        and not (o.status = 'cancelled' and o.amount_paid = 0)
        and (o.placed_at at time zone ${tz})::date between ${from}::date and ${to}::date
    ), l as (
      select coalesce(sum(ol.unit_price * ol.quantity), 0) as gross, coalesce(sum(ol.quantity), 0) as units
      from order_lines ol join o on o.id = ol.order_id
    )
    select
      (select count(*) from o)::int as orders,
      (select gross from l)::bigint as gross,
      (select units from l)::int as units,
      coalesce((select sum(discount_total) from o), 0)::bigint as discounts,
      coalesce((select sum(amount_refunded) from o), 0)::bigint as returns,
      coalesce((select sum(shipping_total) from o), 0)::bigint as shipping,
      coalesce((select sum(case when taxes_included then 0 else tax_total end) from o), 0)::bigint as taxes_added,
      coalesce((select sum(tax_total) from o), 0)::bigint as taxes,
      coalesce((select sum(total) from o), 0)::bigint as total,
      (select count(distinct customer_id) from o)::int as customers,
      (select count(distinct o.customer_id) from o where exists (
        select 1 from ${orders} p where p.store_id = o.store_id and p.customer_id = o.customer_id and p.placed_at < o.placed_at and p.placed_at is not null
      ))::int as returning
  `);
  const r = rows[0]!;
  const n = (k: string) => Number(r[k] ?? 0);
  const orderCount = n("orders");
  const grossSales = n("gross");
  const discounts = n("discounts");
  const returns = n("returns");
  // With tax-inclusive prices the tax sits inside gross sales; Shopify reports it separately.
  const taxesInside = n("taxes") - n("taxes_added");
  const netSales = grossSales - taxesInside - discounts - returns;
  const totalSales = netSales + n("shipping") + n("taxes");
  return {
    orders: orderCount,
    grossSales: grossSales - taxesInside,
    discounts,
    returns,
    netSales,
    shipping: n("shipping"),
    taxes: n("taxes"),
    totalSales,
    averageOrderValue: orderCount ? Math.round(n("total") / orderCount) : 0,
    customers: n("customers"),
    returningCustomers: n("returning"),
    returningCustomerRate: n("customers") ? Math.round((n("returning") / n("customers")) * 10_000) / 100 : 0,
    unitsSold: n("units"),
  };
}

async function series(db: Executor, storeId: string, tz: string, from: string, to: string) {
  const { rows } = await db.execute<{ day: string; orders: number; sales: string }>(sql`
    select d::date::text as day,
      count(o.id)::int as orders,
      coalesce(sum(o.total - o.amount_refunded), 0)::bigint as sales
    from generate_series(${from}::date, ${to}::date, interval '1 day') d
    left join ${orders} o on o.store_id = ${storeId} and o.placed_at is not null
      and not (o.status = 'cancelled' and o.amount_paid = 0)
      and (o.placed_at at time zone ${tz})::date = d::date
    group by d order by d
  `);
  return rows.map((r) => ({ day: r.day, orders: Number(r.orders), sales: Number(r.sales) }));
}

async function topProducts(db: Executor, storeId: string, tz: string, from: string, to: string, limit = 10) {
  const { rows } = await db.execute<{ product_id: string | null; title: string; units: number; sales: string }>(sql`
    select ol.product_id, min(ol.title) as title, sum(ol.quantity)::int as units, sum(ol.unit_price * ol.quantity - ol.discount_amount)::bigint as sales
    from order_lines ol join ${orders} o on o.id = ol.order_id
    where o.store_id = ${storeId} and o.placed_at is not null and o.status <> 'cancelled' and ${placedIn(tz, from, to)}
    group by ol.product_id order by units desc, sales desc limit ${limit}
  `);
  return rows.map((r) => ({ productId: r.product_id, title: r.title, units: Number(r.units), sales: Number(r.sales) }));
}

async function breakdown(db: Executor, storeId: string, tz: string, from: string, to: string, column: "source_name" | "payment_provider") {
  const col = sql.raw(`o.${column}`);
  const { rows } = await db.execute<{ key: string | null; orders: number; sales: string }>(sql`
    select ${col} as key, count(*)::int as orders, sum(o.total - o.amount_refunded)::bigint as sales
    from ${orders} o
    where o.store_id = ${storeId} and o.placed_at is not null and not (o.status = 'cancelled' and o.amount_paid = 0) and ${placedIn(tz, from, to)}
    group by 1 order by sales desc
  `);
  return rows.map((r) => ({ key: r.key ?? "unknown", orders: Number(r.orders), sales: Number(r.sales) }));
}

async function funnel(db: Executor, storeId: string, from: string, to: string) {
  const [r] = await db
    .select({
      sessions: sql<number>`coalesce(sum(${analyticsDaily.sessions}), 0)::int`,
      pageViews: sql<number>`coalesce(sum(${analyticsDaily.pageViews}), 0)::int`,
      addToCarts: sql<number>`coalesce(sum(${analyticsDaily.addToCarts}), 0)::int`,
      checkoutsStarted: sql<number>`coalesce(sum(${analyticsDaily.checkoutsStarted}), 0)::int`,
      orders: sql<number>`coalesce(sum(${analyticsDaily.orders}), 0)::int`,
    })
    .from(analyticsDaily)
    .where(and(eq(analyticsDaily.storeId, storeId), gte(analyticsDaily.day, from), lte(analyticsDaily.day, to)));
  const f = { sessions: r?.sessions ?? 0, pageViews: r?.pageViews ?? 0, addToCarts: r?.addToCarts ?? 0, checkoutsStarted: r?.checkoutsStarted ?? 0, orders: r?.orders ?? 0 };
  const rate = (a: number, b: number) => (b ? Math.round((a / b) * 10_000) / 100 : null);
  return { ...f, conversionRate: rate(f.orders, f.sessions), cartToCheckout: rate(f.checkoutsStarted, f.addToCarts), checkoutToOrder: rate(f.orders, f.checkoutsStarted) };
}

const pct = (cur: number, prev: number) => (prev === 0 ? null : Math.round(((cur - prev) / Math.abs(prev)) * 10_000) / 100);

export async function salesReport(db: Executor, storeId: string, query: ReportQuery) {
  const q = reportQuery.parse(query);
  if (q.to < q.from) throw new Error("`to` is before `from`");
  const { tz, currency } = await tzOf(db, storeId);
  const prevRange = comparisonRange(q);
  const [current, previous, daily, top, channels, payments, conversion, previousSeries] = await Promise.all([
    summary(db, storeId, tz, q.from, q.to),
    prevRange ? summary(db, storeId, tz, prevRange.from, prevRange.to) : null,
    series(db, storeId, tz, q.from, q.to),
    topProducts(db, storeId, tz, q.from, q.to),
    breakdown(db, storeId, tz, q.from, q.to, "source_name"),
    breakdown(db, storeId, tz, q.from, q.to, "payment_provider"),
    funnel(db, storeId, q.from, q.to),
    prevRange ? series(db, storeId, tz, prevRange.from, prevRange.to) : null,
  ]);
  const changes = previous
    ? Object.fromEntries((Object.keys(current) as (keyof SalesSummary)[]).map((k) => [k, pct(current[k], previous[k])]))
    : null;
  return { currency, timezone: tz, range: { from: q.from, to: q.to }, compareRange: prevRange, current, previous, changes, daily, previousDaily: previousSeries, topProducts: top, byChannel: channels, byPaymentMethod: payments, funnel: conversion };
}
export type SalesReport = Awaited<ReturnType<typeof salesReport>>;

/** PLS dashboard cards: orders today / 7 / 30 days, by status, payments, top products. */
export async function dashboardCards(db: Executor, storeId: string, at: Date = new Date()) {
  const { tz, currency } = await tzOf(db, storeId);
  const { rows } = await db.execute<Record<string, number | string>>(sql`
    with o as (select * from ${orders} where store_id = ${storeId} and placed_at is not null),
    t as (select (${at.toISOString()}::timestamptz at time zone ${tz})::date as today)
    select
      (select count(*) from o)::int as total,
      (select coalesce(sum(ol.quantity), 0) from order_lines ol join o on o.id = ol.order_id)::int as items,
      (select count(*) from o, t where (o.placed_at at time zone ${tz})::date = t.today)::int as today,
      (select count(*) from o where o.placed_at > ${at.toISOString()}::timestamptz - interval '7 days')::int as week,
      (select count(*) from o where o.placed_at > ${at.toISOString()}::timestamptz - interval '30 days')::int as month,
      (select count(*) from o where status = 'open' and fulfillment_status = 'unfulfilled' and financial_status in ('paid','partially_paid','pending'))::int as to_fulfil,
      (select count(*) from o where fulfillment_status = 'partially_fulfilled')::int as partially_fulfilled,
      (select count(*) from o where fulfillment_status = 'fulfilled')::int as fulfilled,
      (select count(*) from o where status = 'cancelled')::int as cancelled,
      (select count(*) from o where fulfillment_status = 'returned')::int as returned,
      (select coalesce(sum(amount_paid), 0) from o)::bigint as received,
      (select coalesce(sum(amount_refunded), 0) from o)::bigint as refunded,
      (select count(*) from o where amount_paid > 0)::int as paid_count,
      (select count(*) from o where financial_status = 'pending' and status <> 'cancelled')::int as unpaid_count,
      (select count(*) from ${orders} x where x.store_id = ${storeId} and x.placed_at is null and x.created_at > ${at.toISOString()}::timestamptz - interval '30 days')::int as not_completed,
      (select count(*) from returns r where r.store_id = ${storeId} and r.status in ('requested','approved'))::int as open_returns
  `);
  const r = rows[0]!;
  const n = (k: string) => Number(r[k] ?? 0);
  const from30 = new Date(at.getTime() - 29 * DAY).toISOString().slice(0, 10);
  return {
    currency,
    totals: { orders: n("total"), items: n("items"), today: n("today"), last7Days: n("week"), last30Days: n("month") },
    byStatus: { toFulfil: n("to_fulfil"), partiallyFulfilled: n("partially_fulfilled"), fulfilled: n("fulfilled"), returned: n("returned"), cancelled: n("cancelled"), openReturns: n("open_returns") },
    payments: { net: n("received") - n("refunded"), refunded: n("refunded"), paidCount: n("paid_count"), unpaidCount: n("unpaid_count"), notCompleted: n("not_completed") },
    topProducts: await topProducts(db, storeId, tz, from30, at.toISOString().slice(0, 10), 5),
  };
}

// ── CSV export ───────────────────────────────────────────────────────────────
export const reportExportQuery = reportQuery.extend({ kind: z.enum(["sales_by_day", "top_products", "orders", "by_channel", "by_payment_method"]).default("sales_by_day") });

const csvCell = (v: string | number | null | undefined) => {
  const s = v === null || v === undefined ? "" : String(v);
  // Neutralise spreadsheet formulas (CSV injection) and quote when needed.
  const safe = /^[=+\-@\t\r]/.test(s) && !/^-?\d/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};
const toCsv = (rows: (string | number | null | undefined)[][]) => rows.map((r) => r.map(csvCell).join(",")).join("\n") + "\n";
const major = (minor: number, digits: number) => (minor / 10 ** digits).toFixed(digits);

export async function reportCsv(db: Executor, storeId: string, query: z.input<typeof reportExportQuery>): Promise<{ filename: string; csv: string }> {
  const q = reportExportQuery.parse(query);
  const { tz, currency } = await tzOf(db, storeId);
  let digits = 2;
  try {
    digits = new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions().maximumFractionDigits ?? 2;
  } catch {
    /* default 2 */
  }
  const name = `${q.kind}-${q.from}-to-${q.to}.csv`;
  if (q.kind === "sales_by_day") {
    const rows = await series(db, storeId, tz, q.from, q.to);
    return { filename: name, csv: toCsv([["Day", "Orders", `Net sales (${currency})`], ...rows.map((r) => [r.day, r.orders, major(r.sales, digits)])]) };
  }
  if (q.kind === "top_products") {
    const rows = await topProducts(db, storeId, tz, q.from, q.to, 1000);
    return { filename: name, csv: toCsv([["Product", "Units", `Sales (${currency})`], ...rows.map((r) => [r.title, r.units, major(r.sales, digits)])]) };
  }
  if (q.kind === "by_channel" || q.kind === "by_payment_method") {
    const rows = await breakdown(db, storeId, tz, q.from, q.to, q.kind === "by_channel" ? "source_name" : "payment_provider");
    return { filename: name, csv: toCsv([[q.kind === "by_channel" ? "Channel" : "Payment method", "Orders", `Sales (${currency})`], ...rows.map((r) => [r.key, r.orders, major(r.sales, digits)])]) };
  }
  const rows = await db
    .select()
    .from(orders)
    .where(and(eq(orders.storeId, storeId), placedIn(tz, q.from, q.to, sql`${orders.placedAt}`)))
    .orderBy(orders.placedAt)
    .limit(50_000);
  return {
    filename: name,
    csv: toCsv([
      ["Order", "Placed at", "Email", "Financial status", "Fulfillment status", "Subtotal", "Discounts", "Shipping", "Taxes", "Total", "Refunded", "Payment method", "Channel"],
      ...rows.map((o) => [o.name, o.placedAt?.toISOString(), o.email, o.financialStatus, o.fulfillmentStatus, major(o.subtotal, digits), major(o.discountTotal, digits), major(o.shippingTotal, digits), major(o.taxTotal, digits), major(o.total, digits), major(o.amountRefunded, digits), o.paymentProvider, o.sourceName]),
    ]),
  };
}

// ── analytics_daily rollup (worker) ──────────────────────────────────────────
/**
 * Recomputes the first-party columns of `analytics_daily` for one store day from the database:
 * add-to-carts (cart lines created), checkouts started, orders placed and revenue. Sessions and
 * page views come from the storefront tracker (Phase 5) and are left untouched.
 */
export async function rollupAnalyticsDay(db: Executor, storeId: string, day: string) {
  const { tz } = await tzOf(db, storeId);
  const inDay = (col: unknown) => sql`(${col} at time zone ${tz})::date = ${day}::date`;
  const [carts] = await db.select({ n: sql<number>`count(*)::int` }).from(cartLines).where(and(eq(cartLines.storeId, storeId), inDay(cartLines.createdAt)));
  const [cos] = await db.select({ n: sql<number>`count(*)::int` }).from(checkouts).where(and(eq(checkouts.storeId, storeId), inDay(checkouts.createdAt)));
  const [ord] = await db
    .select({ n: sql<number>`count(*)::int`, revenue: sql<number>`coalesce(sum(${orders.total}), 0)::bigint` })
    .from(orders)
    .where(and(eq(orders.storeId, storeId), inDay(orders.placedAt)));
  const values = { addToCarts: carts?.n ?? 0, checkoutsStarted: cos?.n ?? 0, orders: ord?.n ?? 0, revenue: Number(ord?.revenue ?? 0) };
  await db
    .insert(analyticsDaily)
    .values({ storeId, day, ...values })
    .onConflictDoUpdate({ target: [analyticsDaily.storeId, analyticsDaily.day], set: values });
  return values;
}
