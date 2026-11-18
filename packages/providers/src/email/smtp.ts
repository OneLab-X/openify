import nodemailer from "nodemailer";
import { z } from "zod";
import { errorMessage } from "../http.js";
import type { EmailProvider, ProviderContext, ProviderDefinition } from "../types.js";
import { formatFrom, senderFields } from "./shared.js";

const configSchema = z.object({
  host: z.string().min(1).meta({ title: "SMTP host" }),
  port: z.number().int().min(1).max(65535).default(587).meta({ title: "Port" }),
  secure: z
    .boolean()
    .default(false)
    .meta({ title: "Implicit TLS", description: "On for port 465; off uses STARTTLS when offered" }),
  username: z.string().optional().meta({ title: "Username" }),
  ...senderFields,
});
const secretsSchema = z.object({ password: z.string().optional().meta({ title: "Password" }) });
type SmtpConfig = z.infer<typeof configSchema>;
type SmtpSecrets = z.infer<typeof secretsSchema>;

export function createSmtp(ctx: ProviderContext<SmtpConfig, SmtpSecrets>): EmailProvider {
  const { host, port, secure, username, fromEmail, fromName, replyTo } = ctx.config;
  const transport = nodemailer.createTransport({
    host,
    port,
    secure,
    ...(username ? { auth: { user: username, pass: ctx.secrets.password ?? "" } } : {}),
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
  });
  return {
    async testCredentials() {
      try {
        await transport.verify();
        return { ok: true };
      } catch (err) {
        return { ok: false, error: `SMTP: ${errorMessage(err)}` };
      }
    },
    async send(msg) {
      const info = await transport.sendMail({
        from: formatFrom(fromEmail, fromName),
        to: msg.to,
        subject: msg.subject,
        html: msg.html,
        text: msg.text,
        ...(msg.replyTo || replyTo ? { replyTo: msg.replyTo ?? replyTo } : {}),
        headers: { "X-Shopkit-Idempotency-Key": msg.idempotencyKey },
      });
      return { id: String(info.messageId) };
    },
  };
}

export const smtp: ProviderDefinition<"email", SmtpConfig, SmtpSecrets> = {
  id: "smtp",
  kind: "email",
  displayName: "SMTP",
  description: "Any SMTP server (Gmail, Zoho, Mailgun, your host…).",
  modes: ["live"],
  configSchema,
  secretsSchema,
  create: createSmtp,
};
