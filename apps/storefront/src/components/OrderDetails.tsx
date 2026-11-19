import type { Schemas } from "@shopkit/sdk";
import { formatMoney } from "@/lib";

type Order = Schemas["OrderPublic"];
const label = (s: string) => s.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

/** Order lines, totals, addresses and shipping updates (status page and account). No hooks. */
export function OrderDetails({ order, locale }: { order: Order; locale: string }) {
  const money = (n: number) => formatMoney(n, order.currency, locale);
  const addr = order.shippingAddress;
  return (
    <div className="grid gap-6">
      <dl className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
        <div>
          <dt className="inline text-muted-foreground">Payment: </dt>
          <dd className="inline" data-testid="financial-status">
            {label(order.financialStatus)}
          </dd>
        </div>
        <div>
          <dt className="inline text-muted-foreground">Fulfillment: </dt>
          <dd className="inline">{label(order.fulfillmentStatus)}</dd>
        </div>
        {order.status === "cancelled" ? <div className="text-red-700">Cancelled</div> : null}
      </dl>
      {order.paymentInstructions ? (
        <div className="rounded-md border border-input p-4 text-sm">
          <p className="font-medium">How to pay: {order.paymentInstructions.title}</p>
          {order.paymentInstructions.details ? <p className="whitespace-pre-line">{order.paymentInstructions.details}</p> : null}
          {order.paymentInstructions.instructions ? <p className="mt-2 whitespace-pre-line text-muted-foreground">{order.paymentInstructions.instructions}</p> : null}
        </div>
      ) : null}
      {order.fulfillments.length ? (
        <section aria-labelledby="shipments-h" className="grid gap-2">
          <h2 id="shipments-h" className="text-lg font-semibold">
            Shipments
          </h2>
          <ul className="grid gap-2 text-sm">
            {order.fulfillments.map((f) => (
              <li key={f.name} className="rounded-md border border-input p-3">
                <p className="font-medium">
                  {label(f.status)} · {f.carrierName}
                </p>
                {f.trackingNumber ? <p>Tracking number: {f.trackingNumber}</p> : null}
                {f.trackingUrl ? (
                  <a href={f.trackingUrl} className="underline" rel="noreferrer" target="_blank">
                    Track your package
                  </a>
                ) : null}
                {f.deliveredAt ? <p className="text-muted-foreground">Delivered {new Date(f.deliveredAt).toLocaleDateString(locale)}</p> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {order.returns.length ? (
        <section aria-labelledby="returns-h" className="grid gap-2">
          <h2 id="returns-h" className="text-lg font-semibold">
            Returns
          </h2>
          <ul className="grid gap-2 text-sm">
            {order.returns.map((r) => (
              <li key={r.id} className="rounded-md border border-input p-3">
                <p className="font-medium">
                  {r.name} · {label(r.status)}
                </p>
                <p className="text-muted-foreground">
                  {r.lines.map((l) => `${order.lines.find((x) => x.id === l.orderLineId)?.title ?? "Item"} × ${l.quantity}`).join(", ")}
                </p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {order.shippingUpdates.length ? (
        <ul className="grid gap-2 text-sm">
          {order.shippingUpdates.map((u) => (
            <li key={u.at} className="rounded-md border border-input p-3">
              <p className="font-medium">Shipped{u.carrier ? ` with ${u.carrier}` : ""}</p>
              {u.trackingNumber ? <p>Tracking number: {u.trackingNumber}</p> : null}
              {u.trackingUrl ? (
                <a href={u.trackingUrl} className="underline" rel="noreferrer" target="_blank">
                  Track your package
                </a>
              ) : null}
              {u.message ? <p className="text-muted-foreground">{u.message}</p> : null}
            </li>
          ))}
        </ul>
      ) : null}
      <ul className="divide-y divide-border border-y border-border">
        {order.lines.map((l) => (
          <li key={l.id} className="flex justify-between gap-4 py-3 text-sm">
            <span>
              {l.title}
              {l.variantTitle ? <span className="text-muted-foreground"> · {l.variantTitle}</span> : null} × {l.quantity}
            </span>
            <span>{money(l.unitPrice * l.quantity)}</span>
          </li>
        ))}
      </ul>
      <dl className="grid gap-1 text-sm sm:ml-auto sm:w-72">
        <div className="flex justify-between">
          <dt>Subtotal</dt>
          <dd>{money(order.subtotal)}</dd>
        </div>
        {order.discountTotal ? (
          <div className="flex justify-between">
            <dt>Discount</dt>
            <dd>−{money(order.discountTotal)}</dd>
          </div>
        ) : null}
        {order.shippingLine ? (
          <div className="flex justify-between">
            <dt>Shipping ({order.shippingLine.title})</dt>
            <dd>{money(order.shippingTotal)}</dd>
          </div>
        ) : null}
        {order.taxLines.map((t) => (
          <div key={`${t.title}-${t.rateBps}`} className="flex justify-between">
            <dt>
              {t.title} {t.rateBps / 100}%{order.taxesIncluded ? " (included)" : ""}
            </dt>
            <dd>{money(t.amount)}</dd>
          </div>
        ))}
        <div className="flex justify-between border-t border-border pt-2 font-semibold">
          <dt>Total</dt>
          <dd data-testid="order-total">{money(order.total)}</dd>
        </div>
        {order.amountRefunded ? (
          <div className="flex justify-between text-muted-foreground">
            <dt>Refunded</dt>
            <dd>−{money(order.amountRefunded)}</dd>
          </div>
        ) : null}
      </dl>
      {addr ? (
        <div className="text-sm">
          <p className="font-medium">Shipping to</p>
          <p className="whitespace-pre-line text-muted-foreground">
            {[[addr.firstName, addr.lastName].filter(Boolean).join(" "), addr.line1, addr.line2, [addr.city, addr.province, addr.postalCode].filter(Boolean).join(", "), addr.country]
              .filter(Boolean)
              .join("\n")}
          </p>
        </div>
      ) : null}
    </div>
  );
}
