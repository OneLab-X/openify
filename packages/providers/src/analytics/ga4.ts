import { z } from "zod";
import { errorMessage, request } from "../http.js";
import { ProviderError, type AnalyticsProvider, type ProviderContext, type ProviderDefinition } from "../types.js";

export const GA4_MP = "https://www.google-analytics.com";

const configSchema = z.object({
  measurementId: z
    .string()
    .regex(/^G-[A-Z0-9]{4,20}$/, "Measurement ID looks like G-XXXXXXXXXX")
    .meta({ title: "Measurement ID" }),
});
const secretsSchema = z.object({
  apiSecret: z
    .string()
    .min(8)
    .optional()
    .meta({
      title: "Measurement Protocol API secret",
      description: "Optional. Enables server-side purchase and refund events.",
    }),
});
type Ga4Config = z.infer<typeof configSchema>;
type Ga4Secrets = z.infer<typeof secretsSchema>;

export function createGa4(ctx: ProviderContext<Ga4Config, Ga4Secrets>): AnalyticsProvider {
  const id = ctx.config.measurementId;
  const mpUrl = (path: string) =>
    `${GA4_MP}${path}?measurement_id=${encodeURIComponent(id)}&api_secret=${encodeURIComponent(ctx.secrets.apiSecret ?? "")}`;

  return {
    async testCredentials() {
      if (!ctx.secrets.apiSecret) return { ok: true, message: "Measurement ID format is valid" };
      try {
        const res = await request(mpUrl("/debug/mp/collect"), {
          method: "POST",
          body: JSON.stringify({ client_id: "shopkit.test", events: [{ name: "shopkit_test" }] }),
        });
        if (!res.ok) return { ok: false, error: `GA4 rejected the request (${res.status})` };
        const body = (await res.json()) as { validationMessages?: { description: string }[] };
        const first = body.validationMessages?.[0];
        return first ? { ok: false, error: first.description } : { ok: true };
      } catch (err) {
        return { ok: false, error: errorMessage(err) };
      }
    },
    clientSnippet() {
      const json = JSON.stringify(id);
      return {
        head:
          `<script async src="https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(id)}"></script>` +
          `<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}` +
          `gtag('js',new Date());gtag('config',${json});</script>`,
        requiresConsent: true,
      };
    },
    async serverEvent(event, payload) {
      if (!ctx.secrets.apiSecret) return;
      const name = event === "signup" ? "sign_up" : event;
      const res = await request(mpUrl("/mp/collect"), {
        method: "POST",
        body: JSON.stringify({
          client_id: payload.clientId ?? "server",
          events: [
            {
              name,
              params: {
                ...(payload.orderId ? { transaction_id: payload.orderId } : {}),
                ...(payload.value !== undefined ? { value: payload.value } : {}),
                ...(payload.currency ? { currency: payload.currency } : {}),
              },
            },
          ],
        }),
      });
      if (!res.ok) throw new ProviderError(`GA4 event failed (${res.status})`, res.status);
    },
  };
}

export const ga4: ProviderDefinition<"analytics", Ga4Config, Ga4Secrets> = {
  id: "ga4",
  kind: "analytics",
  displayName: "Google Analytics 4",
  modes: ["live"],
  configSchema,
  secretsSchema,
  last4Field: "apiSecret",
  create: createGa4,
};
