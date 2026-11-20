import { createHash } from "node:crypto";
import { z } from "zod";
import { errorMessage, request } from "../http.js";
import { ProviderError, type AnalyticsProvider, type ProviderContext, type ProviderDefinition } from "../types.js";
import { js } from "./shared.js";

export const META_GRAPH = "https://graph.facebook.com/v21.0";

const configSchema = z.object({
  pixelId: z.string().regex(/^\d{8,20}$/, "Digits only").meta({ title: "Pixel ID" }),
});
const secretsSchema = z.object({
  accessToken: z.string().min(20).optional().meta({ title: "Conversions API access token", description: "Optional. Sends purchases from the server too." }),
});
type MetaConfig = z.infer<typeof configSchema>;
type MetaSecrets = z.infer<typeof secretsSchema>;

const sha = (v: string) => createHash("sha256").update(v.trim().toLowerCase()).digest("hex");

export function createMetaPixel(ctx: ProviderContext<MetaConfig, MetaSecrets>): AnalyticsProvider {
  const pixel = ctx.config.pixelId;
  return {
    async testCredentials() {
      if (!ctx.secrets.accessToken) return { ok: true, message: "Pixel ID format is valid" };
      try {
        const res = await request(`${META_GRAPH}/${pixel}?fields=id&access_token=${encodeURIComponent(ctx.secrets.accessToken)}`, { method: "GET" });
        return res.ok ? { ok: true } : { ok: false, error: `Meta rejected the token (${res.status})` };
      } catch (err) {
        return { ok: false, error: errorMessage(err) };
      }
    },
    clientSnippet() {
      return {
        head:
          `<script>!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');` +
          `fbq('init',${js(pixel)});fbq('track','PageView');</script>`,
        requiresConsent: true,
      };
    },
    async serverEvent(event, payload) {
      // Conversions API needs a token and at least one customer identifier; Meta has no refund event.
      if (!ctx.secrets.accessToken || event !== "purchase" || !payload.email) return;
      const res = await request(`${META_GRAPH}/${pixel}/events?access_token=${encodeURIComponent(ctx.secrets.accessToken)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          data: [
            {
              event_name: "Purchase",
              event_time: Math.floor(Date.now() / 1000),
              action_source: "website",
              ...(payload.orderId ? { event_id: payload.orderId } : {}),
              event_source_url: payload.url ?? `${ctx.runtime.publicUrl}/`,
              user_data: { em: [sha(payload.email)] },
              custom_data: { currency: payload.currency, value: payload.value ?? 0, ...(payload.orderId ? { order_id: payload.orderId } : {}) },
            },
          ],
        }),
      });
      if (!res.ok) throw new ProviderError(`Meta Conversions API failed (${res.status})`, res.status);
    },
  };
}

export const metaPixel: ProviderDefinition<"analytics", MetaConfig, MetaSecrets> = {
  id: "meta-pixel",
  kind: "analytics",
  displayName: "Meta Pixel",
  description: "Facebook/Instagram ads measurement. Loads only after cookie consent.",
  modes: ["live"],
  configSchema,
  secretsSchema,
  last4Field: "accessToken",
  create: createMetaPixel,
};
