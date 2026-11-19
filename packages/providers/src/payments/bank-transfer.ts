import { z } from "zod";
import {
  ProviderError,
  WebhookSignatureError,
  type PaymentProvider,
  type ProviderContext,
  type ProviderDefinition,
} from "../types.js";

/** Manual bank transfer: the order stays pending until staff mark it paid. No remote API. */
const configSchema = z.object({
  accountDetails: z
    .string()
    .min(5)
    .max(1000)
    .meta({ title: "Bank details shown to the customer", description: "Account name, number, IFSC/IBAN, UPI ID…", widget: "textarea" }),
  instructions: z
    .string()
    .max(500)
    .optional()
    .meta({ title: "Instructions", description: "E.g. use your order number as the payment reference", widget: "textarea" }),
});
const secretsSchema = z.object({});
export type BankTransferConfig = z.infer<typeof configSchema>;

function createBankTransfer(ctx: ProviderContext<BankTransferConfig, Record<string, never>>): PaymentProvider {
  const manual = () => {
    throw new ProviderError("Bank transfers are recorded manually");
  };
  return {
    async testCredentials() {
      return { ok: true, message: "Bank transfer needs no credentials" };
    },
    async createSession({ order, amount, currency }) {
      return {
        providerOrderId: null,
        clientPayload: { provider: "bank-transfer", orderId: order.id, amount, currency, accountDetails: ctx.config.accountDetails, instructions: ctx.config.instructions },
      };
    },
    async verifyReturn() {
      throw new WebhookSignatureError("Bank transfer has no client return");
    },
    async parseWebhook() {
      throw new WebhookSignatureError("Bank transfer has no webhooks");
    },
    refund: async () => manual(),
    getPayment: async () => manual(),
  };
}

export const bankTransfer: ProviderDefinition<"payment", BankTransferConfig, Record<string, never>> = {
  id: "bank-transfer",
  kind: "payment",
  displayName: "Manual bank transfer",
  description: "Customer pays by bank transfer; you mark the order paid.",
  modes: ["live"],
  paymentFlow: "offline",
  configSchema,
  secretsSchema,
  create: createBankTransfer,
};
