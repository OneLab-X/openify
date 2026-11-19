import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@shopkit/ui";
import Link from "next/link";
import type { ReactNode } from "react";
import { serverApi } from "@/lib/api-server";
import { formatMoney } from "@/lib/money";
import { can, requireMe } from "@/lib/session";

function Stat({ label, value, hint, href }: { label: string; value: ReactNode; hint?: string; href?: string }) {
  const body = (
    <Card className={href ? "h-full transition-colors hover:bg-muted/50" : "h-full"}>
      <CardHeader>
        <CardDescription className="text-xs font-medium uppercase tracking-wider">{label}</CardDescription>
        <CardTitle className="text-3xl tabular-nums">{value}</CardTitle>
        {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      </CardHeader>
    </Card>
  );
  return href ? (
    <Link href={href} className="block rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2">
      {body}
    </Link>
  ) : (
    body
  );
}

/** Home: the PLS dashboard cards (orders by period, payments, by status, top products). */
export default async function HomePage() {
  const me = await requireMe();
  const api = await serverApi();
  const { data } = can(me, "home:read") ? await api.GET("/api/admin/dashboard") : { data: undefined };
  const money = (n: number) => formatMoney(n, data?.currency ?? me.store.currency ?? "USD", me.store.locale ?? "en");
  return (
    <div className="grid gap-8">
      <div>
        <h1 className="text-2xl font-semibold">Welcome, {me.staff.name.split(" ")[0]}</h1>
        <p className="text-sm text-muted-foreground">
          {me.store.name} is live at{" "}
          <a className="text-primary underline" href={me.store.publicUrl ?? "/"}>
            {me.store.publicUrl}
          </a>
        </p>
      </div>
      {data ? (
        <>
          <section aria-labelledby="totals" className="grid gap-3">
            <h2 id="totals" className="sr-only">
              Orders
            </h2>
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
              <Stat label="Total orders" value={data.totals.orders} hint={`${data.totals.items} items in total`} href="/orders" />
              <Stat label="Today" value={data.totals.today} />
              <Stat label="Last 7 days" value={data.totals.last7Days} />
              <Stat label="Last 30 days" value={data.totals.last30Days} />
            </div>
          </section>
          <section aria-labelledby="payments" className="grid gap-3">
            <h2 id="payments" className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
              Payments
            </h2>
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
              <Stat label="Received" value={money(data.payments.net)} hint="After refunds" />
              <Stat label="Refunded" value={money(data.payments.refunded)} />
              <Stat label="Paid orders" value={data.payments.paidCount} />
              <Stat label="Awaiting payment" value={data.payments.unpaidCount} hint={`${data.payments.notCompleted} checkouts not completed (30 days)`} />
            </div>
          </section>
          <section aria-labelledby="by-status" className="grid gap-3">
            <h2 id="by-status" className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
              By status
            </h2>
            <div className="grid grid-cols-2 gap-4 lg:grid-cols-3">
              <Stat label="To fulfil" value={data.byStatus.toFulfil} href="/orders?fulfillmentStatus=unfulfilled" />
              <Stat label="Partially fulfilled" value={data.byStatus.partiallyFulfilled} />
              <Stat label="Fulfilled" value={data.byStatus.fulfilled} />
              <Stat label="Open returns" value={data.byStatus.openReturns} href="/orders/returns?status=requested" />
              <Stat label="Returned" value={data.byStatus.returned} />
              <Stat label="Cancelled" value={data.byStatus.cancelled} />
            </div>
          </section>
          <Card>
            <CardHeader>
              <CardTitle>Top products (30 days)</CardTitle>
            </CardHeader>
            <CardContent>
              {data.topProducts.length ? (
                <ol className="grid gap-2 text-sm">
                  {data.topProducts.map((p) => (
                    <li key={p.productId ?? p.title} className="flex justify-between gap-2">
                      {p.productId ? (
                        <Link href={`/products/${p.productId}`} className="hover:underline">
                          {p.title}
                        </Link>
                      ) : (
                        <span>{p.title}</span>
                      )}
                      <span className="tabular-nums text-muted-foreground">
                        {p.units} sold · {money(p.sales)}
                      </span>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="text-sm text-muted-foreground">No sales yet.</p>
              )}
            </CardContent>
          </Card>
        </>
      ) : null}
      {can(me, "reports:read") ? (
        <Link className="text-sm text-primary underline" href="/analytics">
          See sales reports →
        </Link>
      ) : null}
    </div>
  );
}
