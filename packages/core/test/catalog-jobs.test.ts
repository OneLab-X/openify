import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { buffer } from "node:stream/consumers";
import { inventoryAdjustments, jobsLog, media, outboxEvents, products, productVariants } from "@shopkit/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { upsertCredential } from "../src/credentials.js";
import { readMedia } from "../src/media.js";
import { getSetting } from "../src/settings.js";
import {
  assertPublicUrl,
  completeMediaUpload,
  createMediaUpload,
  createProduct,
  deleteMedia,
  deleteStoredObjects,
  getJob,
  importMediaFromUrl,
  jobErrorsCsv,
  parseShopifyCsv,
  processMedia,
  readExport,
  runJob,
  startMediaMigration,
  startProductExport,
  startProductImport,
  toMinor,
  uploadMedia,
  getProductAdmin,
} from "../src/index.js";
import { localB, makeStore, png, shopifyCsv, teeInput } from "./catalog-fixtures.js";
import { ACTOR, makeDeps, type TestDeps } from "./harness.js";

let deps: TestDeps;
let storeId: string;
let server: Server;
let baseUrl = "";

beforeAll(async () => {
  deps = await makeDeps();
  deps.registry.register(localB);
  const image = await png(600, 400, "#2e86de");
  server = createServer((req, res) => {
    if (req.url === "/img.png") res.writeHead(200, { "content-type": "image/png" }).end(image);
    else if (req.url === "/redirect") res.writeHead(302, { location: "/img.png" }).end();
    else if (req.url === "/text") res.writeHead(200, { "content-type": "image/png" }).end("not an image");
    else res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.close();
  await deps.close();
});
beforeEach(async () => {
  await deps.reset();
  storeId = await makeStore(deps);
});

describe("media", () => {
  it("uploads through the API, processes renditions with sharp and serves them", async () => {
    const view = await uploadMedia(deps, ACTOR, storeId, { filename: "Front View.PNG", data: await png(1200, 800), alt: "Front" });
    expect(view).toMatchObject({ alt: "Front", contentType: "image/png", status: "ready", processed: false, sources: [] });
    expect(view.url).toMatch(/\/media\/[0-9a-f-]+\/Front-View\.png$/);
    expect(await processMedia(deps, view.id)).toEqual({ status: "processed", renditions: 10 });
    const [row] = await deps.db.select().from(media);
    expect(row).toMatchObject({ width: 1200, height: 800 });
    expect(row!.renditions.map((r) => `${r.width}.${r.format}`)).toEqual(
      ["160", "320", "640", "1024", "1200"].flatMap((w) => [`${w}.webp`, `${w}.avif`]),
    );
    const served = await readMedia(deps, view.id, "w640.webp");
    expect(served && "object" in served && served.contentType).toBe("image/webp");
    expect((await buffer((served as { object: { body: NodeJS.ReadableStream } }).object.body as never)).subarray(8, 12).toString()).toBe("WEBP");
    expect(await readMedia(deps, view.id, "w9999.webp")).toBeNull();
    expect((await deps.db.select().from(outboxEvents)).map((e) => e.type)).toEqual(["media.created", "media.processed"]);
  });

  it("records images that sniff as PNG but cannot be decoded instead of retrying", async () => {
    const broken = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGNkYPjPgA0wYRUFADMfAQ8cHr02AAAAAElFTkSuQmCC", "base64");
    const view = await uploadMedia(deps, ACTOR, storeId, { filename: "broken.png", data: broken });
    expect(await processMedia(deps, view.id)).toEqual({ status: "skipped", reason: "image could not be decoded" });
    const [row] = await deps.db.select().from(media);
    expect(row!.processingError).toMatch(/libpng/);
    expect(row!.renditions).toEqual([]);
  });

  it("refuses non-images and oversized files", async () => {
    await expect(uploadMedia(deps, ACTOR, storeId, { filename: "x.png", data: Buffer.from("<svg/>") })).rejects.toMatchObject({ code: "validation_failed" });
    await expect(uploadMedia(deps, ACTOR, storeId, { filename: "x.png", data: Buffer.alloc(21 * 1024 * 1024) })).rejects.toMatchObject({ code: "validation_failed" });
  });

  it("local storage has no direct upload; deletion goes through the outbox", async () => {
    expect(await createMediaUpload(deps, ACTOR, storeId, { filename: "a.png", contentType: "image/png", byteSize: 10 })).toEqual({ mediaId: null, upload: null });
    const view = await uploadMedia(deps, ACTOR, storeId, { filename: "a.png", data: await png(100, 100) });
    await processMedia(deps, view.id);
    await deleteMedia(deps, ACTOR, storeId, view.id);
    const evt = (await deps.db.select().from(outboxEvents)).find((e) => e.type === "media.deleted")!;
    const payload = evt.payload as { provider: string; keys: string[] };
    expect(payload.keys).toHaveLength(3);
    await deleteStoredObjects(deps, storeId, payload.provider, payload.keys);
    expect(await completeMediaUpload(deps, ACTOR, storeId, view.id).catch((e: unknown) => e)).toMatchObject({ code: "not_found" });
  });

  it("imports images by URL with an SSRF guard and de-duplication", async () => {
    await expect(assertPublicUrl(`${baseUrl}/img.png`)).rejects.toMatchObject({ message: expect.stringMatching(/not a public address/) });
    await expect(assertPublicUrl("file:///etc/passwd")).rejects.toThrow();
    await expect(assertPublicUrl("http://user:pw@example.com/x.png")).rejects.toThrow();
    await expect(assertPublicUrl("http://[::1]/x")).rejects.toThrow();
    const id = await importMediaFromUrl(deps, ACTOR, storeId, `${baseUrl}/redirect`, { allowPrivate: true, alt: "Blue" });
    expect(await importMediaFromUrl(deps, ACTOR, storeId, `${baseUrl}/redirect`, { allowPrivate: true })).toBe(id);
    await expect(importMediaFromUrl(deps, ACTOR, storeId, `${baseUrl}/text`, { allowPrivate: true })).rejects.toThrow(/PNG, JPEG/);
    await expect(importMediaFromUrl(deps, ACTOR, storeId, `${baseUrl}/missing`, { allowPrivate: true })).rejects.toThrow(/404/);
    expect(await deps.db.$count(media)).toBe(1);
  });
});

describe("shopify csv", () => {
  it("converts decimal prices to minor units", () => {
    expect(toMinor("19.99", 2)).toBe(1999);
    expect(toMinor("1,299.5", 2)).toBe(129_950);
    expect(toMinor("100", 0)).toBe(100);
    expect(toMinor("0.125", 2)).toBe(13);
    expect(() => toMinor("12abc", 2)).toThrow();
  });

  it("parses grouped rows, options, defaults and images", async () => {
    const csv = [
      "Handle,Title,Body (HTML),Vendor,Type,Tags,Published,Option1 Name,Option1 Value,Variant SKU,Variant Grams,Variant Inventory Tracker,Variant Inventory Qty,Variant Inventory Policy,Variant Price,Variant Compare At Price,Variant Requires Shipping,Variant Taxable,Image Src,Image Position,Image Alt Text,Variant Image,Variant Weight Unit,Cost per item,Status",
      'simple,Simple,<p>Hi</p>,V,T,"a, b",TRUE,Title,Default Title,S-1,500,,,deny,10.00,,FALSE,FALSE,https://cdn.test/1.jpg,1,One,,g,2.50,active',
      "simple,,,,,,,,,,,,,,,,,,https://cdn.test/2.jpg,2,Two,,,,",
      "sized,Sized,,,,,FALSE,Size,S,Z-S,1000,shopify,4,continue,5.00,9.00,TRUE,TRUE,,,,https://cdn.test/s.jpg,kg,,",
      "sized,,,,,,,,M,Z-M,1000,shopify,2,continue,6.00,,TRUE,TRUE,,,,,kg,,",
      ",Orphan,,,,,,,,,,,,,1.00,,,,,,,,,,",
    ].join("\n");
    const { products: list, errors } = await parseShopifyCsv(csv, { currency: "INR", weightUnit: "kg" });
    expect(errors).toEqual([{ line: 6, message: "Missing Handle" }]);
    const [simple, sized] = list;
    expect(simple!.input).toMatchObject({ title: "Simple", status: "active", tags: ["a", "b"], options: [], variants: [{ options: [], price: 1000, cost: 250, weight: 500, weightUnit: "g", requiresShipping: false, taxable: false, tracked: false }] });
    expect(simple!.images.map((i) => [i.src, i.alt])).toEqual([["https://cdn.test/1.jpg", "One"], ["https://cdn.test/2.jpg", "Two"]]);
    expect(sized!.input).toMatchObject({ status: "draft", options: [{ name: "Size", values: ["S", "M"] }] });
    expect(sized!.input.variants.map((v) => [v.price, v.compareAtPrice, v.inventoryPolicy, v.weight])).toEqual([[500, 900, "continue", 1], [600, null, "continue", 1]]);
    expect(sized!.quantities).toEqual([4, 2]);
    expect(sized!.images.map((i) => i.src)).toEqual(["https://cdn.test/s.jpg"]);
    await expect(parseShopifyCsv("Title,Price\nx,1\n", { currency: "INR", weightUnit: "kg" })).rejects.toThrow(/Handle/);
  });

  it("imports 500 products through a job, and re-importing is idempotent by handle", async () => {
    const csv = Buffer.from(shopifyCsv(500));
    const job = await startProductImport(deps, ACTOR, storeId, { filename: "products_export.csv", data: csv });
    expect(job.status).toBe("queued");
    expect((await deps.db.select().from(outboxEvents)).at(-1)).toMatchObject({ type: "job.requested", payload: { jobId: job.id } });
    const started = Date.now();
    expect(await runJob(deps, job.id)).toEqual({ status: "completed", errors: 0 });
    const done = await getJob(deps, storeId, job.id);
    expect(done).toMatchObject({ status: "completed", processed: 500, total: 500, errorCount: 0, result: { created: 500, updated: 0, failed: 0 } });
    expect(await deps.db.$count(products)).toBe(500);
    expect(await deps.db.$count(productVariants)).toBe(1500);
    const ledger = await deps.db.$count(inventoryAdjustments);
    expect(ledger).toBe(1500);
    const before = await deps.db.select({ id: productVariants.id }).from(productVariants);
    expect(Date.now() - started).toBeLessThan(120_000);

    const again = await startProductImport(deps, ACTOR, storeId, { filename: "again.csv", data: csv });
    await runJob(deps, again.id);
    expect((await getJob(deps, storeId, again.id)).result).toMatchObject({ created: 0, updated: 500, failed: 0 });
    expect(await deps.db.$count(products)).toBe(500);
    const after = await deps.db.select({ id: productVariants.id }).from(productVariants);
    expect(after.map((v) => v.id).sort()).toEqual(before.map((v) => v.id).sort());
    expect(await deps.db.$count(inventoryAdjustments)).toBe(ledger);

    const p = await getProductAdmin(deps, storeId, (await deps.db.select({ id: products.id }).from(products).limit(1))[0]!.id);
    expect(p.variants[0]).toMatchObject({ currency: "INR", weight: 0.25, cost: 40_000 });
    // Already finished jobs are not re-run.
    expect(await runJob(deps, job.id)).toMatchObject({ status: "skipped" });
  }, 180_000);

  it("reports bad rows without stopping the import", async () => {
    const csv = shopifyCsv(3).replace("1001.00", "abc").replace(",CSV Product 2,", ",,");
    const job = await startProductImport(deps, ACTOR, storeId, { filename: "bad.csv", data: Buffer.from(csv) });
    await runJob(deps, job.id);
    const row = await getJob(deps, storeId, job.id);
    expect(row.result).toMatchObject({ created: 1 });
    expect(row.errorCount).toBe(2);
    const report = jobErrorsCsv(row);
    expect(report.split("\n")[0]).toBe("line,handle,message");
    expect(report).toContain('csv-product-1,"Line 5: ""abc"" is not a price"');
    expect(report).toContain("csv-product-2,Title is required");
    await expect(startProductImport(deps, ACTOR, storeId, { filename: "x.csv", data: Buffer.from("Name,Price\n") })).rejects.toThrow(/Handle/);
  });

  it("exports Shopify CSV that re-imports to the same catalog", async () => {
    await createProduct(deps, ACTOR, storeId, teeInput());
    await createProduct(deps, ACTOR, storeId, { title: "Plain", status: "draft", variants: [{ price: 12_345, sku: "P-1" }] });
    const job = await startProductExport(deps, ACTOR, storeId, {});
    await runJob(deps, job.id);
    const { object, filename } = await readExport(deps, storeId, job.id);
    expect(filename).toMatch(/^products-\d{4}-\d{2}-\d{2}\.csv$/);
    const csv = (await buffer(object.body)).toString();
    expect(csv.split("\n")[0]).toMatch(/^Handle,Title,Body \(HTML\),Vendor/);
    const parsed = await parseShopifyCsv(csv, { currency: "INR", weightUnit: "kg" });
    expect(parsed.errors).toEqual([]);
    const tee = parsed.products.find((p) => p.handle === "block-print-tee")!;
    expect(tee.input.variants).toHaveLength(6);
    expect(tee.input.variants[0]).toMatchObject({ price: 99_900, compareAtPrice: 149_900, sku: "TEE-S-Red", hsnCode: "6109", weight: 0.2 });
    expect(parsed.products.find((p) => p.handle === "plain")!.input).toMatchObject({ status: "draft", options: [], variants: [{ price: 12_345 }] });
  });
});

describe("media migration", () => {
  it("copies originals and renditions to the new provider, then activates it", async () => {
    await upsertCredential(deps, ACTOR, { storeId, kind: "storage", provider: "local-b", mode: "live" }, { config: { subdirectory: "moved" } });
    const view = await uploadMedia(deps, ACTOR, storeId, { filename: "a.png", data: await png(300, 300) });
    await processMedia(deps, view.id);
    await expect(startMediaMigration(deps, ACTOR, storeId, { provider: "local", mode: "live" })).rejects.toThrow(/already uses/);
    const job = await startMediaMigration(deps, ACTOR, storeId, { provider: "local-b", mode: "live" });
    await expect(startMediaMigration(deps, ACTOR, storeId, { provider: "local-b", mode: "live" })).rejects.toMatchObject({ code: "conflict" });
    await runJob(deps, job.id);
    expect((await getJob(deps, storeId, job.id)).result).toEqual({ moved: 1, failed: 0, total: 1, activated: true });
    expect(await getSetting(deps.db, storeId, "storage.active")).toEqual({ provider: "local-b", mode: "live" });
    const [row] = await deps.db.select().from(media);
    expect(row!.storageProvider).toBe("local-b");
    const served = await readMedia(deps, view.id, "w300.avif");
    expect(served && "object" in served).toBe(true);
    expect(await deps.db.$count(jobsLog)).toBe(1);
  });
});
