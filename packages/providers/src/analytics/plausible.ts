import { z } from "zod";
import { errorMessage, request } from "../http.js";
import { ProviderError, type AnalyticsProvider, type ProviderContext, type ProviderDefinition } from "../types.js";

const configSchema = z.object({
  domain: z
    .string()
    .regex(/^[a-z0-9.-]+\.[a-z]{2,}$/i, "A domain such as shop.example.com")
    .meta({ title: "Site domain", description: "As added in Plausible" }),
  apiHost: z
    .url()
    .default("https://plausible.io")
    .meta({ title: "Plausible host", description: "Change for self-hosted Plausible" }),
});
const secretsSchema = z.object({});
type PlausibleConfig = z.infer<typeof configSchema>;

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

export function createPlausible(ctx: ProviderContext<PlausibleConfig, Record<string, never>>): AnalyticsProvider {
  const host = (ctx.config.apiHost ?? "https://plausible.io").replace(/\/$/, "");
  const scriptUrl = `${host}/js/script.js`;
  return {
    async testCredentials() {
      try {
        const res = await request(scriptUrl, { method: "GET" });
        return res.ok ? { ok: true } : { ok: false, error: `${scriptUrl} returned ${res.status}` };
      } catch (err) {
        return { ok: false, error: errorMessage(err) };
      }
    },
    clientSnippet() {
      return {
        head: `<script defer data-domain="${escapeAttr(ctx.config.domain)}" src="${escapeAttr(scriptUrl)}"></script>`,
        requiresConsent: false,
      };
    },
    async serverEvent(event, payload) {
      const name = event === "purchase" ? "Purchase" : event === "refund" ? "Refund" : "Signup";
      const res = await request(`${host}/api/event`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "User-Agent": payload.userAgent ?? "Shopkit",
          ...(payload.ip ? { "X-Forwarded-For": payload.ip } : {}),
        },
        body: JSON.stringify({
          name,
          domain: ctx.config.domain,
          url: payload.url ?? `${ctx.runtime.publicUrl}/`,
          ...(payload.orderId ? { props: { orderId: payload.orderId } } : {}),
          ...(payload.value !== undefined && payload.currency
            ? { revenue: { amount: payload.value, currency: payload.currency } }
            : {}),
        }),
      });
      if (!res.ok) throw new ProviderError(`Plausible event failed (${res.status})`, res.status);
    },
  };
}

export const plausible: ProviderDefinition<"analytics", PlausibleConfig, Record<string, never>> = {
  id: "plausible",
  kind: "analytics",
  displayName: "Plausible",
  description: "Cookieless analytics; no consent banner needed.",
  modes: ["live"],
  configSchema,
  secretsSchema,
  create: createPlausible,
};
