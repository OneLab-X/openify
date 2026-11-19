import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { buffer } from "node:stream/consumers";
import { afterAll, describe, expect, it } from "vitest";
import type { StorageProvider } from "../src/types.js";

export interface ContractTarget {
  name: string;
  /** Called lazily (after beforeAll hooks start emulators). */
  make(): StorageProvider;
  /** Signed URLs point at something this test process can fetch. */
  fetchSignedUrls: boolean;
  /** The adapter must implement createUploadUrl, and the URL is fetchable from here. */
  directUpload: "fetchable" | "present" | "absent";
  /** publicUrl() must return a URL (configured public base) or null (proxy). */
  expectPublicUrl: boolean;
}

/**
 * The storage contract every adapter must pass (docs/prompts/02-catalog.md "Done when"). Runs
 * against emulators in CI and against real accounts in the env-gated live tests. Every key lives
 * under a random prefix, which is removed afterwards.
 */
export function storageContract(target: ContractTarget) {
  describe(`storage contract: ${target.name}`, () => {
    const prefix = `contract-${randomUUID()}`;
    const k = (name: string) => `${prefix}/${name}`;
    let provider: StorageProvider;
    const p = () => (provider ??= target.make());

    afterAll(async () => {
      if (!provider) return;
      for await (const key of provider.list(`${prefix}/`)) await provider.delete(key).catch(() => undefined);
    });

    it("testCredentials writes and removes a probe", async () => {
      expect(await p().testCredentials()).toEqual({ ok: true });
    });

    it("round-trips buffers and streams, including content type and length", async () => {
      const png = Buffer.from("89504e470d0a1a0a", "hex");
      await p().put(k("a.png"), png, { contentType: "image/png", cacheControl: "public, max-age=60" });
      const obj = await p().get(k("a.png"));
      expect(obj).not.toBeNull();
      expect(await buffer(obj!.body)).toEqual(png);
      if (obj!.contentType) expect(obj!.contentType).toMatch(/^image\/png/);
      if (obj!.contentLength !== undefined) expect(obj!.contentLength).toBe(png.length);

      await p().put(k("dir/b.txt"), Readable.from([Buffer.from("hello "), Buffer.from("stream")]), { contentType: "text/plain" });
      expect((await buffer((await p().get(k("dir/b.txt")))!.body)).toString()).toBe("hello stream");
    });

    it("overwrites an existing key", async () => {
      await p().put(k("over.txt"), Buffer.from("one"), { contentType: "text/plain" });
      await p().put(k("over.txt"), Buffer.from("two!"), { contentType: "text/plain" });
      expect((await buffer((await p().get(k("over.txt")))!.body)).toString()).toBe("two!");
    });

    it("keeps keys with spaces and unicode intact", async () => {
      const key = k("spaced name/ünïcode ✓.txt");
      await p().put(key, Buffer.from("u"), { contentType: "text/plain" });
      expect((await buffer((await p().get(key))!.body)).toString()).toBe("u");
      const listed: string[] = [];
      for await (const x of p().list(k("spaced name/"))) listed.push(x);
      expect(listed).toEqual([key]);
    });

    it("returns null for missing keys and deletes idempotently", async () => {
      expect(await p().get(k("missing.txt"))).toBeNull();
      await expect(p().delete(k("missing.txt"))).resolves.toBeUndefined();
      await p().put(k("gone.txt"), Buffer.from("x"), { contentType: "text/plain" });
      await p().delete(k("gone.txt"));
      expect(await p().get(k("gone.txt"))).toBeNull();
    });

    it("lists only keys under the prefix", async () => {
      await p().put(k("list/one.txt"), Buffer.from("1"), { contentType: "text/plain" });
      await p().put(k("list/two.txt"), Buffer.from("2"), { contentType: "text/plain" });
      await p().put(k("listing-not.txt"), Buffer.from("3"), { contentType: "text/plain" });
      const keys: string[] = [];
      for await (const key of p().list(k("list/"))) keys.push(key);
      expect(keys.sort()).toEqual([k("list/one.txt"), k("list/two.txt")]);
    });

    it("rejects unsafe keys", async () => {
      for (const bad of ["../escape.txt", "/abs.txt", `${prefix}//x`, ""]) {
        await expect(p().put(bad, Buffer.from(""), { contentType: "text/plain" })).rejects.toThrow();
      }
    });

    it("signs read URLs", async () => {
      await p().put(k("signed.txt"), Buffer.from("signed body"), { contentType: "text/plain" });
      const url = await p().getSignedUrl(k("signed.txt"), { expiresIn: 120 });
      expect(() => new URL(url)).not.toThrow();
      if (target.fetchSignedUrls) {
        const res = await fetch(url);
        expect(res.status).toBe(200);
        expect(await res.text()).toBe("signed body");
      }
    });

    it("publicUrl matches the configuration", () => {
      const url = p().publicUrl(k("pub lic.png"));
      if (target.expectPublicUrl) expect(url).toMatch(/^https?:\/\/.+pub%20lic\.png$/);
      else expect(url).toBeNull();
    });

    it("direct uploads match the declared capability", async () => {
      const create = p().createUploadUrl?.bind(p());
      if (target.directUpload === "absent") {
        expect(create).toBeUndefined();
        return;
      }
      expect(create).toBeTypeOf("function");
      const up = await create!(k("direct.png"), { contentType: "image/png", expiresIn: 300 });
      expect(up.method).toBe("PUT");
      expect(up.headers["content-type"]).toBe("image/png");
      if (target.directUpload !== "fetchable") return;
      const res = await fetch(up.url, { method: "PUT", headers: up.headers, body: new Uint8Array(Buffer.from("direct!")) });
      expect(res.status).toBeLessThan(300);
      expect((await buffer((await p().get(k("direct.png")))!.body)).toString()).toBe("direct!");
    });
  });
}
