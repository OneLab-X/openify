import { z } from "zod";
import {
  ProviderError,
  WebhookSignatureError,
  type PaymentProvider,
  type ProviderContext,
  type ProviderDefinition,
} from "../types.js";

/** Cash on Delivery: no remote API. Payment is recorded manually when the courier collects. */
const configSchema = z.object({
  instructions: z
    .string()
    .max(500)
    .optional()
    .meta({ title: "Instructions shown at checkout", widget: "textarea" }),
  maxOrderAmount: z
    .number()
    .int()
    .positive()
    .optional()
    .meta({ title: "Maximum order amount (minor units)", description: "Leave empty for no limit" }),
});
const secretsSchema = z.object({});
type CodConfig = z.infer<typeof configSchema>;

/* eslint-disable @typescript-eslint/require-await -- COD has no remote calls; methods stay async for the interface */
function createCod(ctx: ProviderContext<CodConfig, Record<string, never>>): PaymentProvider {
  const manual = () => {
    throw new ProviderError("Cash on Delivery payments are recorded manually");
  };
  return {
    async testCredentials() {
      return { ok: true, message: "Cash on Delivery needs no credentials" };
    },
    async createSession({ order, amount, currency }) {
      const max = ctx.config.maxOrderAmount;
      if (max !== undefined && amount > max) throw new ProviderError("Order exceeds the Cash on Delivery limit");
      return {
        providerOrderId: null,
        clientPayload: { provider: "cod", orderId: order.id, amount, currency, instructions: ctx.config.instructions },
      };
    },
    async verifyReturn() {
      throw new WebhookSignatureError("Cash on Delivery has no client return");
    },
    async parseWebhook() {
      throw new WebhookSignatureError("Cash on Delivery has no webhooks");
    },
    refund: async () => manual(),
    getPayment: async () => manual(),
  };
}
/* eslint-enable @typescript-eslint/require-await */

export const cod: ProviderDefinition<"payment", CodConfig, Record<string, never>> = {
  id: "cod",
  kind: "payment",
  displayName: "Cash on Delivery",
  description: "Customer pays the courier on delivery.",
  modes: ["live"],
  configSchema,
  secretsSchema,
  create: createCod,
};
