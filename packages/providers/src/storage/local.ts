import { createReadStream } from "node:fs";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join, relative, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import { z } from "zod";
import { errorMessage } from "../http.js";
import type { ProviderContext, ProviderDefinition, StorageProvider } from "../types.js";
import { signProxyUrl } from "./sign.js";
import { assertSafeKey, PROBE_PREFIX } from "./keys.js";

/** Files on the server's data volume, served through the API's /media proxy. */
const configSchema = z.object({
  subdirectory: z
    .string()
    .regex(/^[a-z0-9][a-z0-9_-]*$/i)
    .default("media")
    .meta({ title: "Folder", description: "Inside the data volume" }),
});
const secretsSchema = z.object({});
type LocalConfig = z.infer<typeof configSchema>;

export function createLocalStorage(ctx: ProviderContext<LocalConfig, Record<string, never>>): StorageProvider {
  const root = join(ctx.runtime.dataDir, ctx.storeId, ctx.config.subdirectory ?? "media");
  const pathFor = (key: string) => join(root, ...assertSafeKey(key).split("/"));

  async function* walk(dir: string): AsyncGenerator<string> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) yield* walk(full);
      else yield relative(root, full).split(sep).join("/");
    }
  }

  const provider: StorageProvider = {
    async testCredentials() {
      const key = `${PROBE_PREFIX}/${randomUUID()}.txt`;
      try {
        await provider.put(key, Buffer.from("shopkit probe"), { contentType: "text/plain" });
        await provider.delete(key);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: `Data folder is not writable: ${errorMessage(err)}` };
      }
    },
    async put(key, body) {
      const path = pathFor(key);
      await mkdir(dirname(path), { recursive: true });
      if (Buffer.isBuffer(body)) await writeFile(path, body);
      else await pipeline(body, createWriteStream(path));
    },
    async get(key) {
      const path = pathFor(key);
      try {
        const info = await stat(path);
        if (!info.isFile()) return null;
        return { body: createReadStream(path), contentLength: info.size };
      } catch {
        return null;
      }
    },
    async getSignedUrl(key, { expiresIn }) {
      return signProxyUrl(ctx.runtime, ctx.storeId, "local", key, expiresIn);
    },
    publicUrl: () => null,
    async delete(key) {
      await rm(pathFor(key), { force: true });
    },
    async *list(prefix) {
      for await (const key of walk(root)) if (key.startsWith(prefix)) yield key;
    },
  };
  return provider;
}

export const localStorage: ProviderDefinition<"storage", LocalConfig, Record<string, never>> = {
  id: "local",
  kind: "storage",
  displayName: "Local disk",
  description: "Stored on this server's data volume. Back it up with your database.",
  modes: ["live"],
  configSchema,
  secretsSchema,
  create: createLocalStorage,
};
