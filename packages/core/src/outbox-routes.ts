import { and, eq, roles, staffUsers } from "@shopkit/db";
import type { CoreDeps } from "./deps.js";
import type { EmailJob } from "./emails/deliver.js";
import type { OutboxEvent } from "./outbox.js";

export const QUEUES = ["outbox", "webhooks-out", "email", "images", "analytics", "revalidate"] as const;
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
      return [
        { queue: "images", name: "process", data: { storeId: event.storeId, ...event.payload }, jobId: `${event.id}-images` },
        revalidate(event, ["store"]),
      ];
    case "email.requested":
      return [{ queue: "email", name: "requested", data: { ...event.payload }, jobId: `${event.id}-email` }];
    default:
      deps.logger.warn({ type: event.type, id: event.id }, "outbox event has no route");
      return [];
  }
}
