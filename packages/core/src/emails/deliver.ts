import { z } from "zod";
import { loadProvider } from "../credentials.js";
import type { CoreDeps } from "../deps.js";
import { AppError } from "../errors.js";
import { getSetting } from "../settings.js";
import { getStore } from "../stores.js";
import { emailDeliveries, eq, sql, UUID_RE } from "@shopkit/db";
import { EMAIL_TEMPLATES, renderEmail, type EmailTemplate, type RenderedEmail } from "./templates.js";
import { isNotificationTemplate, NOTIFICATION_IDS, renderNotification } from "./notifications.js";

const TEMPLATE_IDS = [...Object.keys(EMAIL_TEMPLATES), ...NOTIFICATION_IDS] as [string, ...string[]];

export const emailJob = z.object({
  storeId: z.uuid(),
  template: z.enum(TEMPLATE_IDS),
  to: z.email(),
  data: z.record(z.string(), z.unknown()),
  idempotencyKey: z.string().min(1).max(200),
});
export type EmailJob = z.infer<typeof emailJob>;

/**
 * Sends one templated email with the store's active provider. Safe to retry and to run twice:
 * the `email_deliveries` row for the idempotency key is claimed first, and a key already marked
 * sent is skipped, so each (order, template) is emailed at most once.
 */
export async function deliverEmail(deps: CoreDeps, input: EmailJob): Promise<{ status: "sent" | "skipped"; id?: string; reason?: string }> {
  const job = emailJob.parse(input);
  const active = await getSetting(deps.db, job.storeId, "email.active");
  if (!active) return { status: "skipped", reason: "no email provider" };
  const provider = await loadProvider(deps, { storeId: job.storeId, kind: "email", provider: active.provider, mode: active.mode });
  if (!provider) return { status: "skipped", reason: "email provider disabled" };

  const orderId = typeof job.data.orderId === "string" && UUID_RE.test(job.data.orderId) ? job.data.orderId : null;
  const claimed = await deps.db
    .insert(emailDeliveries)
    .values({ storeId: job.storeId, idempotencyKey: job.idempotencyKey, template: job.template, to: job.to, status: "sending", attempts: 1, orderId })
    .onConflictDoUpdate({
      target: [emailDeliveries.storeId, emailDeliveries.idempotencyKey],
      set: { attempts: sql`${emailDeliveries.attempts} + 1`, status: "sending", updatedAt: new Date() },
      setWhere: sql`${emailDeliveries.status} <> 'sent'`,
    })
    .returning({ id: emailDeliveries.id });
  if (claimed.length === 0) return { status: "skipped", reason: "already sent" };
  const deliveryId = claimed[0]!.id;

  try {
    let rendered: RenderedEmail | null;
    if (isNotificationTemplate(job.template)) rendered = await renderNotification(deps, job.storeId, job.template, job.data);
    else {
      const store = await getStore(deps.db, job.storeId);
      rendered = renderEmail(job.template as EmailTemplate, { storeName: store.name, ...job.data });
    }
    if (!rendered) {
      await deps.db.update(emailDeliveries).set({ status: "failed", error: "skipped: disabled or nothing to send" }).where(eq(emailDeliveries.id, deliveryId));
      return { status: "skipped", reason: "disabled or nothing to send" };
    }
    const store = await getStore(deps.db, job.storeId);
    const { id } = await provider.send({ to: job.to, ...rendered, ...(store.email ? { replyTo: store.email } : {}), idempotencyKey: job.idempotencyKey });
    await deps.db.update(emailDeliveries).set({ status: "sent", providerMessageId: id, sentAt: new Date(), error: null }).where(eq(emailDeliveries.id, deliveryId));
    return { status: "sent", id };
  } catch (err) {
    await deps.db
      .update(emailDeliveries)
      .set({ status: "failed", error: (err instanceof Error ? err.message : String(err)).slice(0, 1000) })
      .where(eq(emailDeliveries.id, deliveryId));
    throw err;
  }
}

/** "Send test email" in setup/settings: a direct action, not a side effect of a write. */
export async function sendTestEmail(deps: CoreDeps, target: { storeId: string; provider: string; mode: "test" | "live" }, to: string) {
  const address = z.email().parse(to);
  const provider = await loadProvider(deps, { ...target, kind: "email" });
  if (!provider) throw new AppError("bad_request", "Save the email provider first");
  const store = await getStore(deps.db, target.storeId);
  try {
    const { id } = await provider.send({
      to: address,
      ...renderEmail("test", { storeName: store.name || "Shopkit" }),
      idempotencyKey: `test:${target.storeId}:${Date.now()}`,
    });
    return { ok: true as const, id };
  } catch (err) {
    return { ok: false as const, error: err instanceof Error ? err.message : "Sending failed" };
  }
}
