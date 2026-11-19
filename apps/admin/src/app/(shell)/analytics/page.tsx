import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label, Select } from "@shopkit/ui";
import type { Metadata } from "next";
import { SalesChart } from "@/components/reports/SalesChart";
import { serverApi } from "@/lib/api-server";
import { formatMoney } from "@/lib/money";
import { requireMe } from "@/lib/session";

export const metadata: Metadata = { title: "Analytics" };

const DAY = 86_400_000;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const isDate = (v: string | undefined): v is string => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v));
type Compare = "none" | "previous_period" | "previous_year";

/** Sales reports (Phase 4): summary with comparison, daily sales, top products, channels, payment methods, funnel, CSV. */
export default async function AnalyticsPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const me = await requireMe();
  const sp = await searchParams;
  const to = isDate(sp.to) ? sp.to : iso(new Date());
  const from = isDate(sp.from) && sp.from <= to ? sp.from : iso(new Date(Date.parse(to) - 29 * DAY));
  const compare: Compare = sp.compare === "none" || sp.compare === "previous_year" ? sp.compare : "previous_period";
  const api = await serverApi();
  const { data } = await api.GET("/api/admin/reports/sales", { params: { query: { from, to, compare } } });
  if (!data) return <p>You do not have access to reports.</p>;
  const locale = me.store.locale ?? "en";
  const money = (n: number) => formatMoney(n, data.currency, locale);
  const c = data.current;
  const change = (k: keyof typeof c) => {
    const v = data.changes?.[k];
    if (v === null || v === undefined) return null;
    return <span className={`text-xs ${v >= 0 ? "text-success" : "text-destructive"}`}>{`${v >= 0 ? "▲" : "▼"} ${Math.abs(v)}% vs ${compare === "previous_year" ? "last year" : "previous period"}`}</span>;
  };
  const csv = (kind: string) => `/api/admin/reports/export?from=${from}&to=${to}&kind=${kind}`;
  const tiles: [string, string, keyof typeof c][] = [
    ["Total sales", money(c.totalSales), "totalSales"],
    ["Net sales", money(c.netSales), "netSales"],
    ["Orders", String(c.orders), "orders"],
    ["Average order value", money(c.averageOrderValue), "averageOrderValue"],
    ["Returning customers", `${c.returningCustomerRate}%`, "returningCustomerRate"],
    ["Units sold", String(c.unitsSold), "unitsSold"],
  ];
  const f = data.funnel;
  const pct = (v: number | null) => (v === null ? "—" : `${v}%`);

  return (
    <div className="grid gap-6">
      <h1 className="text-2xl font-semibold">Analytics</h1>
      <form method="get" className="flex flex-wrap items-end gap-3" aria-label="Report range">
        <div className="grid gap-1">
          <Label htmlFor="r-from">From</Label>
          <Input id="r-from" name="from" type="date" defaultValue={from} />
        </div>
        <div className="grid gap-1">
          <Label htmlFor="r-to">To</Label>
          <Input id="r-to" name="to" type="date" defaultValue={to} />
        </div>
        <div className="grid gap-1">
          <Label htmlFor="r-compare">Compare to</Label>
          <Select id="r-compare" name="compare" defaultValue={compare}>
            <option value="previous_period">Previous period</option>
            <option value="previous_year">Previous year</option>
            <option value="none">No comparison</option>
          </Select>
        </div>
        <Button type="submit" variant="outline">
          Apply
        </Button>
      </form>

      <section aria-labelledby="summary" className="grid gap-3">
        <h2 id="summary" className="sr-only">
          Summary
        </h2>
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
          {tiles.map(([label, value, key]) => (
            <Card key={label}>
              <CardHeader>
                <CardDescription>{label}</CardDescription>
                <CardTitle className="text-2xl tabular-nums">{value}</CardTitle>
                {change(key)}
              </CardHeader>
            </Card>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          Gross {money(c.grossSales)} − discounts {money(c.discounts)} − returns {money(c.returns)} = net {money(c.netSales)}; plus shipping {money(c.shipping)} and taxes {money(c.taxes)}. Days in {data.timezone}.
        </p>
      </section>

      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
          <CardTitle>Net sales by day</CardTitle>
          <a className="text-sm text-primary underline" href={csv("sales_by_day")}>
            Export CSV
          </a>
        </CardHeader>
        <CardContent>
          <SalesChart days={data.daily.map((d) => ({ day: d.day, value: d.sales, label: money(d.sales), orders: d.orders }))} />
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Breakdown title="Top products" csvHref={csv("top_products")} rows={data.topProducts.map((p) => [p.title, `${p.units} sold`, money(p.sales)])} />
        <Card>
          <CardHeader>
            <CardTitle>Conversion funnel</CardTitle>
            <CardDescription>From first-party storefront data (sessions arrive with the storefront tracker).</CardDescription>
          </CardHeader>
          <CardContent>
            <dl className="grid gap-2 text-sm">
              {(
                [
                  ["Sessions", f.sessions, null],
                  ["Added to cart", f.addToCarts, null],
                  ["Reached checkout", f.checkoutsStarted, pct(f.cartToCheckout)],
                  ["Ordered", f.orders, pct(f.checkoutToOrder)],
                ] as const
              ).map(([label, n, rate]) => (
                <div key={label} className="flex justify-between gap-2">
                  <dt>{label}</dt>
                  <dd className="tabular-nums">
                    {n}
                    {rate ? <span className="text-muted-foreground"> · {rate}</span> : null}
                  </dd>
                </div>
              ))}
              <div className="flex justify-between gap-2 border-t border-border pt-2 font-medium">
                <dt>Conversion rate</dt>
                <dd>{pct(f.conversionRate)}</dd>
              </div>
            </dl>
          </CardContent>
        </Card>
        <Breakdown title="Sales by channel" csvHref={csv("by_channel")} rows={data.byChannel.map((r) => [r.key, `${r.orders} orders`, money(r.sales)])} />
        <Breakdown title="Sales by payment method" csvHref={csv("by_payment_method")} rows={data.byPaymentMethod.map((r) => [r.key, `${r.orders} orders`, money(r.sales)])} />
      </div>
      <a className="text-sm text-primary underline" href={csv("orders")}>
        Export orders in this range (CSV)
      </a>
    </div>
  );
}

function Breakdown({ title, rows, csvHref }: { title: string; rows: string[][]; csvHref: string }) {
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
        <CardTitle>{title}</CardTitle>
        <a className="text-sm text-primary underline" href={csvHref}>
          CSV
        </a>
      </CardHeader>
      <CardContent>
        {rows.length ? (
          <ul className="grid gap-2 text-sm">
            {rows.map(([a, b, c]) => (
              <li key={a} className="flex justify-between gap-2">
                <span className="capitalize">{a}</span>
                <span className="tabular-nums text-muted-foreground">
                  {b} · {c}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No sales in this range.</p>
        )}
      </CardContent>
    </Card>
  );
}
