import { z } from "zod";
import { errorMessage, request } from "../http.js";
import { ProviderError, type AnalyticsProvider, type ProviderContext, type ProviderDefinition } from "../types.js";
import { attr, trimSlash } from "./shared.js";

const configSchema = z.object({
  websiteId: z.uuid().meta({ title: "Website ID", description: "Umami → Settings → Websites → Edit" }),
  host: z.url().default("https://cloud.umami.is").meta({ title: "Umami host", description: "Change for self-hosted Umami" }),
});
type UmamiConfig = z.infer<typeof configSchema>;

export function createUmami(ctx: ProviderContext<UmamiConfig, Record<string, never>>): AnalyticsProvider {
  const host = trimSlash(ctx.config.host ?? "https://cloud.umami.is");
  const script = `${host}/script.js`;
  return {
    async testCredentials() {
      try {
        const res = await request(script, { method: "GET" });
        return res.ok ? { ok: true } : { ok: false, error: `${script} returned ${res.status}` };
      } catch (err) {
        return { ok: false, error: errorMessage(err) };
      }
    },
    clientSnippet() {
      // Umami sets no cookies and stores no personal data: no consent needed.
      return { head: `<script defer src="${attr(script)}" data-website-id="${attr(ctx.config.websiteId)}"></script>`, requiresConsent: false };
    },
    async serverEvent(event, payload) {
      const url = new URL(payload.url ?? `${ctx.runtime.publicUrl}/`);
      const res = await request(`${host}/api/send`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": payload.userAgent ?? "Mozilla/5.0 (compatible; Shopkit)" },
        body: JSON.stringify({
          type: "event",
          payload: {
            website: ctx.config.websiteId,
            hostname: url.hostname,
            url: url.pathname,
            name: event,
            data: { ...(payload.orderId ? { orderId: payload.orderId } : {}), ...(payload.value !== undefined ? { revenue: payload.value, currency: payload.currency } : {}) },
          },
        }),
      });
      if (!res.ok) throw new ProviderError(`Umami event failed (${res.status})`, res.status);
    },
  };
}

export const umami: ProviderDefinition<"analytics", UmamiConfig, Record<string, never>> = {
  id: "umami",
  kind: "analytics",
  displayName: "Umami",
  description: "Open-source, cookieless analytics; no consent banner needed.",
  modes: ["live"],
  configSchema,
  secretsSchema: z.object({}),
  create: createUmami,
};
