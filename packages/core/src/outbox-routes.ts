import { and, eq, orders, roles, staffUsers } from "@shopkit/db";
import type { CoreDeps } from "./deps.js";
import type { EmailJob } from "./emails/deliver.js";
import { merchantRecipients, type NotificationTemplate } from "./emails/notifications.js";
import { getSetting } from "./settings.js";
import type { OutboxEvent } from "./outbox.js";

export const QUEUES = [
  "outbox",
  "webhooks-out",
  "email",
  "images",
  "analytics",
  "revalidate",
  "search-index",
  "imports",
  "media-migration",
  "inventory-release",
  "abandoned-cart",
] as const;
export type QueueName = (typeof QUEUES)[number];

export interface RoutedJob {
  queue: QueueName;
  name: string;
  data: Record<string, unknown>;
  /** Stable id so re-dispatching an event never enqueues a duplicate job. */
  jobId: string;
  /** Milliseconds to wait before the job runs (BullMQ delayed job). */
  delay?: number;
}

const revalidate = (event: OutboxEvent, tags: string[]): RoutedJob => ({
  queue: "revalidate",
  name: "tags",
  data: { storeId: event.storeId, tags },
  jobId: `${event.id}-revalidate`,
});

const email = (event: OutboxEvent, template: NotificationTemplate, to: string, data: Record<string, unknown>, key: string): RoutedJob => {
  const job: EmailJob = { storeId: event.storeId, template, to, data, idempotencyKey: key };
  return { queue: "email", name: template, data: { ...job }, jobId: `${event.id}-email-${template}-${to}`.replace(/[^A-Za-z0-9@._-]/g, "_") };
};

/** Customer email for an order event, keyed per order + template (+ refund/update id) so it goes once. */
async function orderEmails(deps: CoreDeps, event: OutboxEvent, template: NotificationTemplate, keySuffix = ""): Promise<RoutedJob[]> {
  const orderId = String(event.payload.orderId);
  const [order] = await deps.db.select({ email: orders.email }).from(orders).where(eq(orders.id, orderId));
  if (!order?.email) return [];
  return [email(event, template, order.email, { ...event.payload }, `order:${orderId}:${template}${keySuffix}`)];
}

async function merchantAlerts(deps: CoreDeps, event: OutboxEvent, template: "merchant_new_order" | "merchant_order_paid"): Promise<RoutedJob[]> {
  const cfg = await getSetting(deps.db, event.storeId, "notifications.config");
  if (template === "merchant_new_order" ? !cfg.alertNewOrder : !cfg.alertPaidOrder) return [];
  const orderId = String(event.payload.orderId);
  return (await merchantRecipients(deps, event.storeId)).map((to) => email(event, template, to, { orderId }, `order:${orderId}:${template}:${to}`));
}

/** Fans an outbox event out to queue jobs (SPEC §13). Unknown events route nowhere. */
export async function routeOutboxEvent(deps: CoreDeps, event: OutboxEvent): Promise<RoutedJob[]> {
  switch (event.type) {
    case "store.launched": {
      const [owner] = await deps.db
        .select({ name: staffUsers.name, email: staffUsers.email })
        .from(staffUsers)
        .innerJoin(roles, eq(roles.id, staffUsers.roleId))
        .where(and(eq(staffUsers.storeId, event.storeId), eq(roles.key, "owner")));
      if (!owner) return [];
      const job: EmailJob = {
        storeId: event.storeId,
        template: "store-launched",
        to: owner.email,
        data: { ownerName: owner.name, adminUrl: `${deps.runtime.publicUrl}/admin`, shopUrl: deps.runtime.publicUrl },
        idempotencyKey: `${event.id}:store-launched`,
      };
      return [
        { queue: "email", name: "store-launched", data: { ...job }, jobId: `${event.id}-email` },
        revalidate(event, ["store"]),
      ];
    }
    case "store.updated":
      return [revalidate(event, ["store"])];
    case "media.created":
      if (event.payload.altOnly) return [revalidate(event, ["store", "products", "collections"])];
      return [
        { queue: "images", name: "process", data: { storeId: event.storeId, ...event.payload }, jobId: `${event.id}-images` },
        revalidate(event, ["store"]),
      ];
    case "media.processed":
      return [revalidate(event, ["store", "products", "collections"])];
    case "media.deleted":
      return [{ queue: "images", name: "delete", data: { storeId: event.storeId, ...event.payload }, jobId: `${event.id}-images` }];
    case "product.created":
    case "product.updated":
    case "product.deleted": {
      const { productId, handle, previousHandle } = event.payload as { productId: string; handle?: string; previousHandle?: string | null };
      const tags = ["products", "collections", `product:${productId}`];
      if (handle) tags.push(`product-handle:${handle}`);
      if (previousHandle) tags.push(`product-handle:${previousHandle}`);
      return [
        revalidate(event, tags),
        { queue: "search-index", name: "sync", data: { storeId: event.storeId, productIds: [productId] }, jobId: `${event.id}-search` },
      ];
    }
    case "collection.created":
    case "collection.updated":
    case "collection.deleted": {
      const { collectionId, handle, previousHandle } = event.payload as { collectionId: string; handle?: string; previousHandle?: string | null };
      const tags = ["collections", `collection:${collectionId}`];
      if (handle) tags.push(`collection-handle:${handle}`);
      if (previousHandle) tags.push(`collection-handle:${previousHandle}`);
      return [revalidate(event, tags)];
    }
    case "job.requested": {
      const { jobId, jobType } = event.payload as { jobId: string; jobType: string };
      return [{ queue: jobType === "media_migration" ? "media-migration" : "imports", name: jobType, data: { storeId: event.storeId, jobId }, jobId: `job-${jobId}` }];
    }
    case "order.placed":
      return [...(await orderEmails(deps, event, "order_confirmation")), ...(await merchantAlerts(deps, event, "merchant_new_order"))];
    case "order.paid":
      return merchantAlerts(deps, event, "merchant_order_paid");
    case "order.payment_failed":
      return orderEmails(deps, event, "payment_failed");
    case "order.cancelled":
      return event.payload.notify === false ? [] : orderEmails(deps, event, "order_cancelled");
    case "order.refunded":
      return event.payload.notify === false ? [] : orderEmails(deps, event, "refund", `:${String(event.payload.refundId)}`);
    case "order.shipping_updated":
      return orderEmails(deps, event, "shipping_update", `:${String(event.payload.eventId)}`);
    case "order.reservation_created": {
      const due = Date.parse(String(event.payload.dueAt));
      const delay = Number.isFinite(due) ? Math.max(0, due - Date.now()) : 0;
      return [{ queue: "inventory-release", name: "release", data: { storeId: event.storeId, orderId: event.payload.orderId }, jobId: `${event.id}-release`, delay }];
    }
    case "checkout.abandoned": {
      const to = typeof event.payload.email === "string" ? event.payload.email : "";
      if (!to) return [];
      return [email(event, "abandoned_checkout", to, { checkoutId: event.payload.checkoutId }, `checkout:${String(event.payload.checkoutId)}:abandoned_checkout`)];
    }
    case "customer.otp_requested":
      return [email(event, "customer_otp", String(event.payload.email), { code: event.payload.code, minutes: event.payload.minutes }, `otp:${event.id}`)];
    case "email.requested":
      return [{ queue: "email", name: "requested", data: { ...event.payload }, jobId: `${event.id}-email` }];
    default:
      deps.logger.warn({ type: event.type, id: event.id }, "outbox event has no route");
      return [];
  }
}
