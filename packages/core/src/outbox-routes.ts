import { and, eq, roles, staffUsers } from "@shopkit/db";
import type { CoreDeps } from "./deps.js";
import type { EmailJob } from "./emails/deliver.js";
import type { OutboxEvent } from "./outbox.js";

export const QUEUES = ["outbox", "webhooks-out", "email", "images", "analytics", "revalidate", "search-index", "imports", "media-migration"] as const;
export type QueueName = (typeof QUEUES)[number];

export interface RoutedJob {
  queue: QueueName;
  name: string;
  data: Record<string, unknown>;
  /** Stable id so re-dispatching an event never enqueues a duplicate job. */
  jobId: string;
}

const revalidate = (event: OutboxEvent, tags: string[]): RoutedJob => ({
  queue: "revalidate",
  name: "tags",
  data: { storeId: event.storeId, tags },
  jobId: `${event.id}-revalidate`,
});

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
    case "email.requested":
      return [{ queue: "email", name: "requested", data: { ...event.payload }, jobId: `${event.id}-email` }];
    default:
      deps.logger.warn({ type: event.type, id: event.id }, "outbox event has no route");
      return [];
  }
}
