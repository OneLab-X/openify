import { ProviderError } from "./types.js";

/** Turns network failures and timeouts into a merchant-readable ProviderError. */
export async function request(url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
  const { timeoutMs = 15_000, ...rest } = init;
  try {
    return await fetch(url, { ...rest, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const reason = err instanceof Error && err.name === "TimeoutError" ? "timed out" : "could not be reached";
    throw new ProviderError(`${new URL(url).host} ${reason}`);
  }
}

export function header(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
