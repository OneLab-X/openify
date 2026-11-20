import { z } from "zod";
import { errorMessage, request } from "../http.js";
import { ProviderError, type AnalyticsProvider, type ProviderContext, type ProviderDefinition } from "../types.js";
import { js, trimSlash } from "./shared.js";

const configSchema = z.object({
  url: z.url().meta({ title: "Matomo URL", description: "e.g. https://analytics.example.com" }),
  siteId: z.coerce.number().int().min(1).meta({ title: "Site ID" }),
  cookieless: z.boolean().default(false).meta({ title: "Cookieless tracking", description: "Turns off Matomo cookies so it can run without consent" }),
});
const secretsSchema = z.object({
  tokenAuth: z.string().min(16).optional().meta({ title: "Auth token", description: "Optional. Lets server-side orders keep the buyer's IP/time." }),
});
type MatomoConfig = z.infer<typeof configSchema>;
type MatomoSecrets = z.infer<typeof secretsSchema>;

export function createMatomo(ctx: ProviderContext<MatomoConfig, MatomoSecrets>): AnalyticsProvider {
  const base = `${trimSlash(ctx.config.url)}/`;
  return {
    async testCredentials() {
      try {
        const res = await request(`${base}matomo.js`, { method: "GET" });
        return res.ok ? { ok: true } : { ok: false, error: `${base}matomo.js returned ${res.status}` };
      } catch (err) {
        return { ok: false, error: errorMessage(err) };
      }
    },
    clientSnippet() {
      return {
        head:
          `<script>var _paq=window._paq=window._paq||[];${ctx.config.cookieless ? "_paq.push(['disableCookies']);" : ""}_paq.push(['trackPageView']);_paq.push(['enableLinkTracking']);` +
          `(function(){var u=${js(base)};_paq.push(['setTrackerUrl',u+'matomo.php']);_paq.push(['setSiteId',${js(String(ctx.config.siteId))}]);` +
          `var d=document,g=d.createElement('script');g.async=true;g.src=u+'matomo.js';d.head.appendChild(g);})();</script>`,
        requiresConsent: !ctx.config.cookieless,
      };
    },
    async serverEvent(event, payload) {
      if (event !== "purchase" || !payload.orderId) return; // Matomo has no refund API
      const q = new URLSearchParams({
        idsite: String(ctx.config.siteId),
        rec: "1",
        apiv: "1",
        url: payload.url ?? `${ctx.runtime.publicUrl}/`,
        idgoal: "0",
        ec_id: payload.orderId,
        revenue: String(payload.value ?? 0),
        _id: (payload.clientId ?? payload.orderId).replace(/[^0-9a-f]/gi, "").padEnd(16, "0").slice(0, 16),
        ...(ctx.secrets.tokenAuth ? { token_auth: ctx.secrets.tokenAuth } : {}),
      });
      const res = await request(`${base}matomo.php`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: q.toString() });
      if (!res.ok) throw new ProviderError(`Matomo event failed (${res.status})`, res.status);
    },
  };
}

export const matomo: ProviderDefinition<"analytics", MatomoConfig, MatomoSecrets> = {
  id: "matomo",
  kind: "analytics",
  displayName: "Matomo",
  description: "Self-hosted or cloud Matomo. Uses cookies unless cookieless tracking is on.",
  modes: ["live"],
  configSchema,
  secretsSchema,
  last4Field: "tokenAuth",
  create: createMatomo,
};
