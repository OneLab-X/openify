import { timingSafeEqual } from "node:crypto";
import { header } from "../http.js";
import { WebhookSignatureError, type TrackingState } from "../types.js";

/** Constant-time comparison of a shared webhook token sent in a header. */
export function requireToken(headers: Record<string, string | string[] | undefined>, name: string, expected: string | undefined): void {
  if (!expected) throw new WebhookSignatureError("Set the webhook token in the provider settings first");
  const got = header(headers, name) ?? "";
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new WebhookSignatureError("Webhook token does not match");
}

/** Maps a carrier's free-text status to our tracking states. */
export function stateFromText(status: string): TrackingState {
  const s = status.toLowerCase();
  if (/rto|return/.test(s)) return "returned";
  if (/cancel/.test(s)) return "cancelled";
  if (/deliver(ed|y completed)|^dl$/.test(s) && !/out for|undeliver|not deliver/.test(s)) return "delivered";
  if (/out for delivery|ofd|dispatched/.test(s)) return "out_for_delivery";
  if (/fail|undeliver|exception|lost|damage/.test(s)) return "failed";
  if (/transit|shipped|picked|in scan|manifest|reached|connected/.test(s)) return "in_transit";
  return "pending";
}

export const kg = (grams: number) => Math.max(grams, 1) / 1000;

export function first<T>(items: readonly T[], by: (t: T) => number): T | undefined {
  return [...items].sort((a, b) => by(a) - by(b))[0];
}
