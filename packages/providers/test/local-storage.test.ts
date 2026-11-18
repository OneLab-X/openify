import { chmod } from "node:fs/promises";
import { Readable } from "node:stream";
import { text } from "node:stream/consumers";
import { describe, expect, it } from "vitest";
import { localStorage } from "../src/storage/local.js";
import { verifyLocalSignature } from "../src/storage/sign.js";
import { ProviderError } from "../src/types.js";
import { ctx, runtime, tempDir } from "./helpers.js";

async function make() {
  const dataDir = await tempDir();
  return { dataDir, p: localStorage.create(ctx({ subdirectory: "media" }, {}, "live", { dataDir })) };
}

describe("local storage", () => {
  it("put/get/list/delete round-trip, including streams", async () => {
    const { p } = await make();
    await p.put("logos/a.png", Buffer.from("png"), { contentType: "image/png" });
    await p.put("logos/b.txt", Readable.from(["hello"]), { contentType: "text/plain" });
    expect(await text((await p.get("logos/b.txt"))!.body)).toBe("hello");
    expect((await p.get("logos/a.png"))!.contentLength).toBe(3);
    const keys: string[] = [];
    for await (const k of p.list("logos/")) keys.push(k);
    expect(keys.sort()).toEqual(["logos/a.png", "logos/b.txt"]);
    await p.delete("logos/a.png");
    expect(await p.get("logos/a.png")).toBeNull();
    expect(await p.get("logos")).toBeNull();
    expect(p.publicUrl("logos/b.txt")).toBeNull();
  });

  it("lists nothing for a missing root", async () => {
    const { p } = await make();
    const keys: string[] = [];
    for await (const k of p.list("")) keys.push(k);
    expect(keys).toEqual([]);
  });

  it("rejects path traversal and absolute keys", async () => {
    const { p } = await make();
    for (const bad of ["../x", "/etc/passwd", "a//b", "a/./b", "a\\b", ""]) {
      await expect(p.put(bad, Buffer.from(""), { contentType: "text/plain" })).rejects.toThrow(ProviderError);
    }
  });

  it("testCredentials writes and removes a probe", async () => {
    const { p } = await make();
    expect(await p.testCredentials()).toEqual({ ok: true });
  });

  it("testCredentials fails when the folder is not writable", async () => {
    const { dataDir } = await make();
    await chmod(dataDir, 0o500);
    try {
      const p = localStorage.create(ctx({ subdirectory: "media" }, {}, "live", { dataDir }));
      expect(await p.testCredentials()).toMatchObject({ ok: false, error: expect.stringMatching(/not writable/) });
    } finally {
      await chmod(dataDir, 0o700);
    }
  });

  it("signs URLs that verify until they expire", async () => {
    const { p } = await make();
    const url = new URL(await p.getSignedUrl("a b.png", { expiresIn: 60 }));
    expect(url.pathname).toMatch(/\/media\/s\/.+\/a%20b\.png$/);
    const exp = Number(url.searchParams.get("exp"));
    const sig = url.searchParams.get("sig")!;
    const store = "0190a1b2-0000-7000-8000-000000000001";
    expect(verifyLocalSignature(runtime.signingSecret, store, "a b.png", exp, sig)).toBe(true);
    expect(verifyLocalSignature(runtime.signingSecret, store, "other.png", exp, sig)).toBe(false);
    expect(verifyLocalSignature(runtime.signingSecret, store, "a b.png", exp, sig, (exp + 1) * 1000)).toBe(false);
    expect(verifyLocalSignature(runtime.signingSecret, store, "a b.png", exp, "zz")).toBe(false);
  });
});
