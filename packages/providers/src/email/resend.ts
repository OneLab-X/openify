import { z } from "zod";
import { errorMessage, request } from "../http.js";
import { ProviderError, type EmailProvider, type ProviderContext, type ProviderDefinition } from "../types.js";
import { formatFrom, senderFields } from "./shared.js";

export const RESEND_API = "https://api.resend.com";

const configSchema = z.object(senderFields);
const secretsSchema = z.object({
  apiKey: z.string().regex(/^re_[A-Za-z0-9_]+$/, "Resend API keys start with re_").meta({ title: "API key" }),
});
type ResendConfig = z.infer<typeof configSchema>;
type ResendSecrets = z.infer<typeof secretsSchema>;

export function createResend(ctx: ProviderContext<ResendConfig, ResendSecrets>): EmailProvider {
  const headers = { Authorization: `Bearer ${ctx.secrets.apiKey}`, "Content-Type": "application/json" };
  return {
    async testCredentials() {
      try {
        const res = await request(`${RESEND_API}/domains`, { headers });
        if (res.ok) return { ok: true };
        const body = (await res.json().catch(() => ({}))) as { name?: string; message?: string };
        // A sending-only key cannot list domains, but it is a valid key.
        if (body.name === "restricted_api_key") return { ok: true, message: "Sending-only API key" };
        return { ok: false, error: body.message ?? `Resend error (${res.status})` };
      } catch (err) {
        return { ok: false, error: errorMessage(err) };
      }
    },
    async send(msg) {
      const res = await request(`${RESEND_API}/emails`, {
        method: "POST",
        headers: { ...headers, "Idempotency-Key": msg.idempotencyKey },
        body: JSON.stringify({
          from: formatFrom(ctx.config.fromEmail, ctx.config.fromName),
          to: [msg.to],
          subject: msg.subject,
          html: msg.html,
          text: msg.text,
          ...(msg.replyTo || ctx.config.replyTo ? { reply_to: msg.replyTo ?? ctx.config.replyTo } : {}),
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { id?: string; message?: string };
      if (!res.ok || !body.id) throw new ProviderError(body.message ?? `Resend error (${res.status})`, res.status);
      return { id: body.id };
    },
  };
}

export const resend: ProviderDefinition<"email", ResendConfig, ResendSecrets> = {
  id: "resend",
  kind: "email",
  displayName: "Resend",
  docsUrl: "https://resend.com/api-keys",
  modes: ["live"],
  configSchema,
  secretsSchema,
  last4Field: "apiKey",
  create: createResend,
};
