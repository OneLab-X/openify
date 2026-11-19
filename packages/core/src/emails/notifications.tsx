import { render } from "@react-email/render";
import { cartLines, checkouts, carts, eq, refunds } from "@shopkit/db";
import type { ReactElement } from "react";
import type { CoreDeps } from "../deps.js";
import { z } from "zod";
import { AppError } from "../errors.js";
import { getSetting, setSetting } from "../settings.js";
import { getStore, storeView } from "../stores.js";
import { formatAddress } from "../commerce/address.js";
import { formatMinor, getOrderPublic, orderStatusUrl } from "../commerce/orders.js";
import { priceLines } from "../commerce/pricing.js";
import { checkoutRecoveryUrl } from "../commerce/recovery.js";
import { Address, Button, H1, Layout, Lines, P, Totals, type EmailLine } from "./components.js";
import type { RenderedEmail } from "./templates.js";

/**
 * Order and customer notifications (Phase 3 item 6). Each template has a default subject and intro
 * that merchants can override in Settings → Notifications; the body (lines, totals, links) is
 * rendered from live data when the email job runs.
 */
export const NOTIFICATION_TEMPLATES = {
  order_confirmation: { title: "Order confirmation", audience: "customer", subject: "Order {{order_name}} confirmed", intro: "Thanks for your order! We'll let you know when it ships." },
  payment_failed: {
    title: "Payment failed",
    audience: "customer",
    subject: "Your payment to {{shop_name}} didn't go through",
    intro: "Your payment was not completed, so your order hasn't been placed yet. Your items are still in your cart if you'd like to try again.",
  },
  order_cancelled: { title: "Order cancelled", audience: "customer", subject: "Order {{order_name}} has been cancelled", intro: "Your order has been cancelled. If you were charged, a refund is on its way." },
  shipping_update: { title: "Shipping update", audience: "customer", subject: "Order {{order_name}} is on its way", intro: "Good news: your order has shipped." },
  refund: { title: "Refund", audience: "customer", subject: "Refund for order {{order_name}}", intro: "We've issued a refund for your order. It can take a few business days to appear on your statement." },
  customer_otp: { title: "Sign-in code", audience: "customer", subject: "{{code}} is your {{shop_name}} sign-in code", intro: "Use this code to sign in. It expires in {{minutes}} minutes. If you didn't ask for it, you can ignore this email." },
  abandoned_checkout: { title: "Abandoned checkout", audience: "customer", subject: "You left something in your cart", intro: "Your items are still waiting for you. Complete your purchase whenever you're ready." },
  merchant_new_order: { title: "New order (staff alert)", audience: "merchant", subject: "[{{shop_name}}] New order {{order_name}}", intro: "You have a new order." },
  merchant_order_paid: { title: "Order paid (staff alert)", audience: "merchant", subject: "[{{shop_name}}] Order {{order_name}} paid", intro: "Payment was received for an order." },
} as const;
export type NotificationTemplate = keyof typeof NOTIFICATION_TEMPLATES;
export const NOTIFICATION_IDS = Object.keys(NOTIFICATION_TEMPLATES) as NotificationTemplate[];

export const isNotificationTemplate = (t: string): t is NotificationTemplate => t in NOTIFICATION_TEMPLATES;

/** Payload values are JSON scalars; anything else renders as empty. */
const str = (v: unknown): string => (typeof v === "string" || typeof v === "number" ? String(v) : "");

function fill(text: string, vars: Record<string, string>) {
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, k: string) => vars[k] ?? "");
}

/** Effective subject/intro/enabled for each template (defaults merged with merchant overrides). */
export async function notificationSettings(deps: Pick<CoreDeps, "db">, storeId: string) {
  const overrides = await getSetting(deps.db, storeId, "notifications.templates");
  return NOTIFICATION_IDS.map((id) => {
    const def = NOTIFICATION_TEMPLATES[id];
    const o = overrides[id] ?? {};
    return {
      id,
      title: def.title,
      audience: def.audience,
      subject: o.subject?.trim() || def.subject,
      intro: o.intro?.trim() || def.intro,
      enabled: id === "customer_otp" ? true : (o.enabled ?? true),
      defaultSubject: def.subject,
      defaultIntro: def.intro,
    };
  });
}

async function renderBoth(element: ReactElement): Promise<{ html: string; text: string }> {
  const [html, text] = await Promise.all([render(element), render(element, { plainText: true })]);
  return { html, text };
}

/**
 * Renders a notification. Returns null when the merchant disabled it or its subject no longer
 * exists (an order deleted before the job ran).
 */
export async function renderNotification(deps: CoreDeps, storeId: string, template: NotificationTemplate, data: Record<string, unknown>): Promise<RenderedEmail | null> {
  const settings = (await notificationSettings(deps, storeId)).find((s) => s.id === template)!;
  if (!settings.enabled) return null;
  const store = await getStore(deps.db, storeId);
  const shop = await storeView(deps, store);
  const accent = shop.brand.primaryColor ?? null;
  const vars: Record<string, string> = { shop_name: shop.name, code: str(data.code ?? ""), minutes: str(data.minutes ?? "") };
  const layout = (preview: string, body: ReactElement) => (
    <Layout shopName={shop.name} logoUrl={shop.logoUrl} preview={preview} accent={accent}>
      {body}
    </Layout>
  );

  if (template === "customer_otp") {
    const intro = fill(settings.intro, vars);
    const { html, text } = await renderBoth(
      layout(
        intro,
        <>
          <H1>Your sign-in code</H1>
          <P>{intro}</P>
          <p style={{ fontSize: 32, letterSpacing: 6, fontWeight: 700, margin: "16px 0" }}>{vars.code}</p>
        </>,
      ),
    );
    return { subject: fill(settings.subject, vars), html, text };
  }

  if (template === "abandoned_checkout") {
    const checkoutId = str(data.checkoutId ?? "");
    const [row] = await deps.db.select({ checkout: checkouts, cart: carts }).from(checkouts).innerJoin(carts, eq(carts.id, checkouts.cartId)).where(eq(checkouts.id, checkoutId));
    if (!row || row.checkout.status === "completed") return null;
    const items = await deps.db.select().from(cartLines).where(eq(cartLines.cartId, row.cart.id));
    const pricing = await priceLines(deps.db, storeId, { lines: items.map((l) => ({ variantId: l.variantId, quantity: l.quantity })), discountCode: row.cart.discountCode });
    if (pricing.lines.length === 0) return null;
    const lines: EmailLine[] = pricing.lines.map((l) => ({ title: l.title, variantTitle: l.variantTitle, quantity: l.quantity, total: formatMinor(l.subtotal, pricing.currency) }));
    const url = checkoutRecoveryUrl(deps, checkoutId);
    const intro = fill(settings.intro, vars);
    const { html, text } = await renderBoth(
      layout(
        intro,
        <>
          <H1>Your cart is waiting</H1>
          <P>{intro}</P>
          <Lines lines={lines} />
          <Totals rows={[{ label: "Subtotal", value: formatMinor(pricing.subtotal, pricing.currency), strong: true }]} />
          <Button href={url} color={accent}>
            Complete your purchase
          </Button>
        </>,
      ),
    );
    return { subject: fill(settings.subject, vars), html, text };
  }

  // Order templates
  const orderId = str(data.orderId ?? "");
  const order = await getOrderPublic(deps, storeId, orderId).catch(() => null);
  if (!order) return null;
  vars.order_name = order.name || "";
  vars.customer_name = order.shippingAddress?.firstName ?? "";
  const money = (n: number) => formatMinor(n, order.currency);
  const lines: EmailLine[] = order.lines.map((l) => ({ title: l.title, variantTitle: l.variantTitle, quantity: l.quantity, total: money(l.unitPrice * l.quantity) }));
  const totals = [
    { label: "Subtotal", value: money(order.subtotal) },
    ...(order.discountTotal ? [{ label: "Discount", value: `−${money(order.discountTotal)}` }] : []),
    ...(order.shippingLine ? [{ label: `Shipping (${order.shippingLine.title})`, value: money(order.shippingTotal) }] : []),
    ...order.taxLines.map((t) => ({ label: `${t.title} ${t.rateBps / 100}%${order.taxesIncluded ? " (included)" : ""}`, value: money(t.amount) })),
    { label: "Total", value: money(order.total), strong: true },
  ];
  const statusUrl = orderStatusUrl(deps, order.id);
  const adminUrl = `${deps.runtime.publicUrl}/admin/orders/${order.id}`;
  const intro = fill(settings.intro, vars);
  let heading = `Order ${order.name}`;
  let extra: ReactElement | null = null;
  let button: ReactElement | null = (
    <Button href={statusUrl} color={accent}>
      View your order
    </Button>
  );

  switch (template) {
    case "order_confirmation":
      heading = `Thank you! Order ${order.name} is confirmed`;
      if (order.financialStatus === "pending" && order.paymentProvider) extra = <P muted>Payment is pending. We'll start preparing your order once it's received.</P>;
      break;
    case "payment_failed":
      heading = "Your payment didn't go through";
      button = (
        <Button href={`${deps.runtime.publicUrl}/cart`} color={accent}>
          Return to your cart
        </Button>
      );
      break;
    case "order_cancelled":
      heading = `Order ${order.name} cancelled`;
      break;
    case "shipping_update": {
      heading = `Order ${order.name} has shipped`;
      const carrier = str(data.carrier) || null;
      const tracking = str(data.trackingNumber) || null;
      const trackingUrl = typeof data.trackingUrl === "string" ? data.trackingUrl : null;
      extra = (
        <>
          {carrier || tracking ? <P>{[carrier, tracking && `Tracking number: ${tracking}`].filter(Boolean).join("\n")}</P> : null}
          {str(data.message) ? <P>{str(data.message)}</P> : null}
          {trackingUrl ? (
            <Button href={trackingUrl} color={accent}>
              Track your package
            </Button>
          ) : null}
        </>
      );
      break;
    }
    case "refund": {
      const [refund] = data.refundId ? await deps.db.select().from(refunds).where(eq(refunds.id, str(data.refundId))) : [];
      heading = "Your refund is on its way";
      extra = refund ? <P>{`Refund amount: ${money(refund.amount)}`}</P> : null;
      break;
    }
    case "merchant_new_order":
    case "merchant_order_paid":
      heading = template === "merchant_new_order" ? `New order ${order.name}` : `Order ${order.name} paid`;
      extra = <P>{`${order.email ?? ""}${order.phone ? ` · ${order.phone}` : ""}\nPayment: ${order.financialStatus.replace("_", " ")}${order.paymentProvider ? ` (${order.paymentProvider})` : ""}`}</P>;
      button = (
        <Button href={adminUrl} color={accent}>
          Open in admin
        </Button>
      );
      break;
  }

  const { html, text } = await renderBoth(
    layout(
      intro,
      <>
        <H1>{heading}</H1>
        <P>{intro}</P>
        {extra}
        {button}
        <Lines lines={lines} />
        <Totals rows={totals} />
        <Address title="Shipping address" lines={formatAddress(order.shippingAddress)} />
      </>,
    ),
  );
  return { subject: fill(settings.subject, vars), html, text };
}

export const templateUpdateInput = z.object({
  subject: z.string().trim().max(200).optional(),
  intro: z.string().trim().max(2000).optional(),
  enabled: z.boolean().optional(),
});

/** Saves a template override; empty strings fall back to the default text. */
export async function updateNotificationTemplate(deps: Pick<CoreDeps, "db">, storeId: string, id: string, input: z.input<typeof templateUpdateInput>) {
  if (!isNotificationTemplate(id)) throw new AppError("not_found", "Unknown template");
  const d = templateUpdateInput.parse(input);
  const current = await getSetting(deps.db, storeId, "notifications.templates");
  const next = { ...current, [id]: { ...current[id], ...d } };
  await setSetting(deps.db, storeId, "notifications.templates", next);
  return (await notificationSettings(deps, storeId)).find((t) => t.id === id)!;
}

/** Staff recipients for merchant alerts: configured addresses, else the store email. */
export async function merchantRecipients(deps: Pick<CoreDeps, "db">, storeId: string): Promise<string[]> {
  const cfg = await getSetting(deps.db, storeId, "notifications.config");
  if (cfg.merchantEmails.length) return cfg.merchantEmails;
  const store = await getStore(deps.db, storeId);
  return store.email ? [store.email] : [];
}
