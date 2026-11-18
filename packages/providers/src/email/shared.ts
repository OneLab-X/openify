import { z } from "zod";

export const senderFields = {
  fromEmail: z.email().meta({ title: "From address" }),
  fromName: z.string().max(100).optional().meta({ title: "From name" }),
  replyTo: z.email().optional().meta({ title: "Reply-to address" }),
};

export function formatFrom(email: string, name?: string): string {
  if (!name) return email;
  return `"${name.replace(/["\\\r\n]/g, "")}" <${email}>`;
}
