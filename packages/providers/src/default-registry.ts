import { ga4 } from "./analytics/ga4.js";
import { plausible } from "./analytics/plausible.js";
import { resend } from "./email/resend.js";
import { smtp } from "./email/smtp.js";
import { cod } from "./payments/cod.js";
import { razorpay } from "./payments/razorpay.js";
import { ProviderRegistry } from "./registry.js";
import { localStorage } from "./storage/local.js";
import { s3CompatibleStorage, s3Storage } from "./storage/s3.js";
import type { ComingSoonProvider } from "./types.js";

/** Providers listed in SPEC §7 that are not implemented yet. The wizard shows them as "coming soon". */
export const COMING_SOON: ComingSoonProvider[] = [
  { kind: "payment", id: "stripe", displayName: "Stripe" },
  { kind: "payment", id: "paypal", displayName: "PayPal" },
  { kind: "payment", id: "cashfree", displayName: "Cashfree" },
  { kind: "payment", id: "phonepe", displayName: "PhonePe" },
  { kind: "payment", id: "bank-transfer", displayName: "Manual bank transfer" },
  { kind: "storage", id: "r2", displayName: "Cloudflare R2" },
  { kind: "storage", id: "gcs", displayName: "Google Cloud Storage" },
  { kind: "storage", id: "azure-blob", displayName: "Azure Blob Storage" },
  { kind: "storage", id: "b2", displayName: "Backblaze B2" },
  { kind: "storage", id: "google-drive", displayName: "Google Drive" },
  { kind: "email", id: "ses", displayName: "Amazon SES" },
  { kind: "email", id: "postmark", displayName: "Postmark" },
  { kind: "analytics", id: "umami", displayName: "Umami" },
  { kind: "analytics", id: "matomo", displayName: "Matomo" },
  { kind: "analytics", id: "posthog", displayName: "PostHog" },
  { kind: "analytics", id: "meta-pixel", displayName: "Meta Pixel" },
  { kind: "shipping", id: "manual", displayName: "Manual / local delivery" },
  { kind: "shipping", id: "shiprocket", displayName: "Shiprocket" },
  { kind: "shipping", id: "delhivery", displayName: "Delhivery" },
  { kind: "shipping", id: "easypost", displayName: "EasyPost" },
];

export function createDefaultRegistry(): ProviderRegistry {
  const registry = new ProviderRegistry();
  for (const def of [localStorage, s3CompatibleStorage, s3Storage, razorpay, cod, smtp, resend, ga4, plausible]) {
    registry.register(def);
  }
  for (const entry of COMING_SOON) registry.registerComingSoon(entry);
  return registry;
}
