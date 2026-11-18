import { ProviderError } from "../types.js";

/** Object keys are relative, slash-separated, and never escape the root. */
export function assertSafeKey(key: string): string {
  if (
    !key ||
    key.length > 1024 ||
    key.startsWith("/") ||
    key.includes("\\") ||
    key.includes("\0") ||
    key.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new ProviderError(`Invalid object key "${key}"`);
  }
  return key;
}

export function encodeKey(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

export const PROBE_PREFIX = ".shopkit-probe";
