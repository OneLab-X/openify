import { z } from "zod";
import { loadProvider } from "../credentials.js";
import type { CoreDeps } from "../deps.js";
import { AppError } from "../errors.js";
import { getSetting } from "../settings.js";
import { getStore } from "../stores.js";
import { EMAIL_TEMPLATES, renderEmail, type EmailTemplate } from "./templates.js";

export const emailJob = z.object({
  storeId: z.uuid(),
  template: z.enum(Object.keys(EMAIL_TEMPLATES) as [EmailTemplate, ...EmailTemplate[]]),
  to: z.email(),
  data: z.record(z.string(), z.unknown()),
  idempotencyKey: z.string().min(1).max(200),
});
export type EmailJob = z.infer<typeof emailJob>;

const sentKey = (k: string) => `sk:email:sent:${k}`;

/** Sends one templated email with the store's active provider. Safe to retry: deduped by idempotency key. */
export async function deliverEmail(deps: CoreDeps, input: EmailJob): Promise<{ status: "sent" | "skipped"; id?: string; reason?: string }> {
  const job = emailJob.parse(input);
  if (await deps.redis.exists(sentKey(job.idempotencyKey))) return { status: "skipped", reason: "already sent" };
  const active = await getSetting(deps.db, job.storeId, "email.active");
  if (!active) return { status: "skipped", reason: "no email provider" };
  const provider = await loadProvider(deps, { storeId: job.storeId, kind: "email", provider: active.provider, mode: active.mode });
  if (!provider) return { status: "skipped", reason: "email provider disabled" };
  const store = await getStore(deps.db, job.storeId);
  const rendered = renderEmail(job.template, { storeName: store.name, ...job.data });
  const { id } = await provider.send({ to: job.to, ...rendered, idempotencyKey: job.idempotencyKey });
  await deps.redis.set(sentKey(job.idempotencyKey), id, "EX", 7 * 24 * 3600);
  return { status: "sent", id };
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
