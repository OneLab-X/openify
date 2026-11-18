import { text } from "node:stream/consumers";
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { s3CompatibleStorage, s3Storage } from "../src/storage/s3.js";
import { ctx } from "./helpers.js";

let minio: StartedTestContainer;
let endpoint: string;
const creds = { accessKeyId: "shopkit", secretAccessKey: "shopkit-secret" };

beforeAll(async () => {
  // MinIO no longer publishes community images; RustFS is the S3-compatible stand-in (DECISIONS.md D-003).
  minio = await new GenericContainer("rustfs/rustfs:1.0.5")
    .withEnvironment({ RUSTFS_ACCESS_KEY: creds.accessKeyId, RUSTFS_SECRET_KEY: creds.secretAccessKey })
    .withExposedPorts(9000)
    .withWaitStrategy(Wait.forHttp("/health", 9000))
    .start();
  endpoint = `http://${minio.getHost()}:${minio.getMappedPort(9000)}`;
  const client = new S3Client({ endpoint, region: "us-east-1", forcePathStyle: true, credentials: creds });
  await client.send(new CreateBucketCommand({ Bucket: "shop" }));
});
afterAll(async () => {
  await minio?.stop();
});

const make = (secrets = creds, bucket = "shop", publicBaseUrl?: string) =>
  s3CompatibleStorage.create(
    ctx({ endpoint, bucket, region: "us-east-1", forcePathStyle: true, ...(publicBaseUrl ? { publicBaseUrl } : {}) }, secrets, "live"),
  );

describe("S3-compatible storage (RustFS)", () => {
  it("testCredentials uploads and deletes a probe", async () => {
    expect(await make().testCredentials()).toEqual({ ok: true });
  });

  it("reports bad credentials and missing buckets", async () => {
    const bad = await make({ accessKeyId: "nope", secretAccessKey: "wrong-secret" }).testCredentials();
    expect(bad).toMatchObject({ ok: false, error: expect.stringMatching(/Access denied/) });
    const missing = await make(creds, "missing-bucket").testCredentials();
    expect(missing).toMatchObject({ ok: false, error: "Bucket does not exist" });
  });

  it("put/get/list/delete/sign", async () => {
    const p = make();
    await p.put("logos/a.txt", Buffer.from("hi"), { contentType: "text/plain", cacheControl: "public, max-age=60" });
    const obj = await p.get("logos/a.txt");
    expect(obj).toMatchObject({ contentType: "text/plain", contentLength: 2 });
    expect(await text(obj!.body)).toBe("hi");
    const keys: string[] = [];
    for await (const k of p.list("logos/")) keys.push(k);
    expect(keys).toEqual(["logos/a.txt"]);
    const signed = await p.getSignedUrl("logos/a.txt", { expiresIn: 60 });
    expect(await (await fetch(signed)).text()).toBe("hi");
    await p.delete("logos/a.txt");
    expect(await p.get("logos/a.txt")).toBeNull();
  });

  it("publicUrl uses the configured base URL or the media proxy", () => {
    expect(make().publicUrl("a b.png")).toBeNull();
    expect(make(creds, "shop", "https://cdn.test/").publicUrl("a b.png")).toBe("https://cdn.test/a%20b.png");
  });

  it("AWS S3 variant has no endpoint field", () => {
    const shape = Object.keys((s3Storage.configSchema as unknown as { shape: object }).shape);
    expect(shape).not.toContain("endpoint");
  });
});
