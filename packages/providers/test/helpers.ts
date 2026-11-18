import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderContext, ProviderMode, ProviderRuntime } from "../src/types.js";

export const runtime: ProviderRuntime = {
  publicUrl: "https://shop.test",
  dataDir: "/tmp/shopkit-unused",
  signingSecret: "signing-secret-for-tests",
};

export function ctx<C, S>(config: C, secrets: S, mode: ProviderMode = "test", rt: Partial<ProviderRuntime> = {}): ProviderContext<C, S> {
  return { storeId: "0190a1b2-0000-7000-8000-000000000001", mode, config, secrets, runtime: { ...runtime, ...rt } };
}

export const tempDir = () => mkdtemp(join(tmpdir(), "shopkit-"));
