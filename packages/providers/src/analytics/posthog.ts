import { z } from "zod";
import { errorMessage, request } from "../http.js";
import { ProviderError, type AnalyticsProvider, type ProviderContext, type ProviderDefinition } from "../types.js";
import { js, trimSlash } from "./shared.js";

const configSchema = z.object({
  apiKey: z.string().regex(/^phc_[A-Za-z0-9]{20,64}$/, "Project API key starts with phc_").meta({ title: "Project API key", description: "Public key from PostHog → Project settings" }),
  host: z.url().default("https://us.i.posthog.com").meta({ title: "API host", description: "https://eu.i.posthog.com for the EU cloud, or your self-hosted URL" }),
});
type PosthogConfig = z.infer<typeof configSchema>;

export function createPosthog(ctx: ProviderContext<PosthogConfig, Record<string, never>>): AnalyticsProvider {
  const host = trimSlash(ctx.config.host ?? "https://us.i.posthog.com");
  return {
    async testCredentials() {
      try {
        const res = await request(`${host}/decide/?v=3`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ api_key: ctx.config.apiKey, distinct_id: "shopkit-test" }) });
        return res.ok ? { ok: true } : { ok: false, error: `PostHog rejected the key (${res.status})` };
      } catch (err) {
        return { ok: false, error: errorMessage(err) };
      }
    },
    clientSnippet() {
      return {
        head:
          `<script>!function(t,e){var o,n,p,r;e.__SV||(window.posthog=e,e._i=[],e.init=function(i,s,a){function g(t,e){var o=e.split(".");2==o.length&&(t=t[o[0]],e=o[1]),t[e]=function(){t.push([e].concat(Array.prototype.slice.call(arguments,0)))}}(p=t.createElement("script")).type="text/javascript",p.async=!0,p.src=s.api_host.replace(".i.posthog.com","-assets.i.posthog.com")+"/static/array.js",(r=t.getElementsByTagName("script")[0]).parentNode.insertBefore(p,r);var u=e;for(void 0!==a?u=e[a]=[]:a="posthog",u.people=u.people||[],u.toString=function(t){var e="posthog";return"posthog"!==a&&(e+="."+a),t||(e+=" (stub)"),e},u.people.toString=function(){return u.toString(1)+".people (stub)"},o="capture identify alias people.set people.set_once set_config register register_once unregister opt_out_capturing has_opted_out_capturing opt_in_capturing reset isFeatureEnabled onFeatureFlags getFeatureFlag getFeatureFlagPayload reloadFeatureFlags group".split(" "),n=0;n<o.length;n++)g(u,o[n]);e._i.push([i,s,a])},e.__SV=1)}(document,window.posthog||[]);` +
          `posthog.init(${js(ctx.config.apiKey)},{api_host:${js(host)},person_profiles:"identified_only"});</script>`,
        requiresConsent: true,
      };
    },
    async serverEvent(event, payload) {
      const res = await request(`${host}/capture/`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: ctx.config.apiKey,
          event: event === "signup" ? "sign_up" : event,
          distinct_id: payload.clientId ?? payload.orderId ?? "server",
          properties: { $process_person_profile: false, ...(payload.orderId ? { order_id: payload.orderId } : {}), ...(payload.value !== undefined ? { revenue: payload.value, currency: payload.currency } : {}) },
        }),
      });
      if (!res.ok) throw new ProviderError(`PostHog event failed (${res.status})`, res.status);
    },
  };
}

export const posthog: ProviderDefinition<"analytics", PosthogConfig, Record<string, never>> = {
  id: "posthog",
  kind: "analytics",
  displayName: "PostHog",
  modes: ["live"],
  configSchema,
  secretsSchema: z.object({}),
  create: createPosthog,
};
