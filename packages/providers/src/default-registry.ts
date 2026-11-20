import { ga4 } from "./analytics/ga4.js";
import { matomo } from "./analytics/matomo.js";
import { metaPixel } from "./analytics/meta-pixel.js";
import { plausible } from "./analytics/plausible.js";
import { posthog } from "./analytics/posthog.js";
import { umami } from "./analytics/umami.js";
import { resend } from "./email/resend.js";
import { smtp } from "./email/smtp.js";
import { bankTransfer } from "./payments/bank-transfer.js";
import { cashfree } from "./payments/cashfree.js";
import { cod } from "./payments/cod.js";
import { paypal } from "./payments/paypal.js";
import { phonepe } from "./payments/phonepe.js";
import { razorpay } from "./payments/razorpay.js";
import { stripe } from "./payments/stripe.js";
import { ProviderRegistry } from "./registry.js";
import { delhivery } from "./shipping/delhivery.js";
import { easypost } from "./shipping/easypost.js";
import { shiprocket } from "./shipping/shiprocket.js";
import { localStorage } from "./storage/local.js";
import { azureBlobStorage } from "./storage/azure.js";
import { gcsStorage } from "./storage/gcs.js";
import { googleDriveStorage } from "./storage/google-drive.js";
import { b2Storage, r2Storage, s3CompatibleStorage, s3Storage } from "./storage/s3.js";
import type { ComingSoonProvider } from "./types.js";

/** Providers listed in SPEC §7 that are not implemented yet. The wizard shows them as "coming soon". */
export const COMING_SOON: ComingSoonProvider[] = [
  { kind: "email", id: "ses", displayName: "Amazon SES" },
  { kind: "email", id: "postmark", displayName: "Postmark" },
];

export function createDefaultRegistry(): ProviderRegistry {
  const registry = new ProviderRegistry();
  for (const def of [localStorage, s3CompatibleStorage, s3Storage, r2Storage, gcsStorage, azureBlobStorage, b2Storage, googleDriveStorage, razorpay, stripe, paypal, cashfree, phonepe, cod, bankTransfer, smtp, resend, ga4, plausible, umami, matomo, posthog, metaPixel, shiprocket, delhivery, easypost]) {
    registry.register(def);
  }
  for (const entry of COMING_SOON) registry.registerComingSoon(entry);
  return registry;
}
