import { z } from "zod";
import { ProviderError } from "../types.js";

/** Google service-account key file (JSON), pasted as a secret. */
export const serviceAccountJson = z
  .string()
  .min(20)
  .refine((v) => {
    try {
      const parsed = JSON.parse(v) as Record<string, unknown>;
      return typeof parsed.client_email === "string" && typeof parsed.private_key === "string";
    } catch {
      return false;
    }
  }, "Paste the whole service-account key file (JSON with client_email and private_key)")
  .meta({ title: "Service account key (JSON)", description: "IAM → Service accounts → Keys → Add key → JSON", widget: "textarea" });

export interface ServiceAccount {
  client_email: string;
  private_key: string;
  project_id?: string;
}

export function parseServiceAccount(json: string): ServiceAccount {
  try {
    const parsed = JSON.parse(json) as ServiceAccount;
    if (typeof parsed.client_email !== "string" || typeof parsed.private_key !== "string") throw new Error("missing fields");
    return parsed;
  } catch {
    throw new ProviderError("Service account key is not valid JSON with client_email and private_key");
  }
}
