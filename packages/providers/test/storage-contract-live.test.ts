import { describe, it } from "vitest";
import { createDefaultRegistry } from "../src/default-registry.js";
import type { StorageProvider } from "../src/types.js";
import { ctx } from "./helpers.js";
import { storageContract } from "./storage-contract.js";

/**
 * The same contract against real accounts. Opt in per provider with an env var holding the saved
 * credential shape, e.g.
 *   SHOPKIT_LIVE_STORAGE_R2='{"config":{"accountId":"…","bucket":"…"},"secrets":{"accessKeyId":"…","secretAccessKey":"…"}}'
 * Ids: S3, S3_COMPATIBLE, R2, GCS, AZURE_BLOB, B2, GOOGLE_DRIVE. Everything is written under a random
 * prefix and removed afterwards.
 */
const registry = createDefaultRegistry();
const envName = (id: string) => `SHOPKIT_LIVE_STORAGE_${id.toUpperCase().replace(/-/g, "_")}`;
const live = registry.definitions("storage").filter((d) => d.id !== "local");

for (const def of live) {
  const raw = process.env[envName(def.id)];
  describe.skipIf(!raw)(`live ${def.id} (${envName(def.id)})`, () => {
    if (!raw) return;
    const { config, secrets } = JSON.parse(raw) as { config: Record<string, unknown>; secrets: Record<string, unknown> };
    storageContract({
      name: `${def.displayName} (live)`,
      make: () => def.create(ctx(def.configSchema.parse(config), def.secretsSchema.parse(secrets), "live")) as StorageProvider,
      fetchSignedUrls: def.id !== "google-drive",
      directUpload: def.id === "google-drive" ? "absent" : "fetchable",
      expectPublicUrl: typeof config.publicBaseUrl === "string",
    });
  });
}

describe("live storage tests", () => {
  it("are opt-in", () => undefined);
});
