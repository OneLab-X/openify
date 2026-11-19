import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { BlobServiceClient, StorageSharedKeyCredential } from "@azure/storage-blob";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { azureBlobStorage } from "../src/storage/azure.js";
import { localStorage } from "../src/storage/local.js";
import { b2Storage, createS3Storage, r2Storage, s3CompatibleStorage, s3Storage } from "../src/storage/s3.js";
import { ctx, tempDir } from "./helpers.js";
import { storageContract } from "./storage-contract.js";

/**
 * Every adapter against an emulator: RustFS for the S3-API family (DECISIONS.md D-003), Azurite for Azure Blob. GCS (fake-gcs-server) and Google Drive (in-process fake) have their own files;
 * real accounts run in storage-contract-live.test.ts when credentials are provided.
 */
const creds = { accessKeyId: "shopkit", secretAccessKey: "shopkit-secret" };
const AZURITE = { account: "devstoreaccount1", key: "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==" };

let rustfs: StartedTestContainer;
let azurite: StartedTestContainer;
let s3Endpoint = "";
let azureEndpoint = "";
let localDir = "";

beforeAll(async () => {
  localDir = await tempDir();
  [rustfs, azurite] = await Promise.all([
    new GenericContainer("rustfs/rustfs:1.0.5")
      .withEnvironment({ RUSTFS_ACCESS_KEY: creds.accessKeyId, RUSTFS_SECRET_KEY: creds.secretAccessKey })
      .withExposedPorts(9000)
      .withWaitStrategy(Wait.forHttp("/health", 9000))
      .start(),
    new GenericContainer("mcr.microsoft.com/azure-storage/azurite:3.35.0")
      .withCommand(["azurite-blob", "--blobHost", "0.0.0.0", "--skipApiVersionCheck", "--loose"])
      .withExposedPorts(10000)
      .withWaitStrategy(Wait.forListeningPorts())
      .start(),
  ]);
  s3Endpoint = `http://${rustfs.getHost()}:${rustfs.getMappedPort(9000)}`;
  const s3 = new S3Client({ endpoint: s3Endpoint, region: "us-east-1", forcePathStyle: true, credentials: creds });
  for (const bucket of ["contract-s3", "contract-r2", "contract-b2"]) await s3.send(new CreateBucketCommand({ Bucket: bucket }));

  azureEndpoint = `http://${azurite.getHost()}:${azurite.getMappedPort(10000)}/${AZURITE.account}`;
  const service = new BlobServiceClient(azureEndpoint, new StorageSharedKeyCredential(AZURITE.account, AZURITE.key));
  await service.getContainerClient("contract-azure").createIfNotExists();
});

afterAll(async () => {
  await Promise.all([rustfs?.stop(), azurite?.stop()]);
});

storageContract({
  name: "local",
  make: () => localStorage.create(ctx({ subdirectory: "media" }, {}, "live", { dataDir: localDir })),
  fetchSignedUrls: false,
  directUpload: "absent",
  expectPublicUrl: false,
});

storageContract({
  name: "s3-compatible (RustFS)",
  make: () => s3CompatibleStorage.create(ctx({ endpoint: s3Endpoint, bucket: "contract-s3", region: "us-east-1", forcePathStyle: true }, creds, "live")),
  fetchSignedUrls: true,
  directUpload: "fetchable",
  expectPublicUrl: false,
});

storageContract({
  name: "aws s3 (RustFS endpoint)",
  make: () => createS3Storage({ endpoint: s3Endpoint, bucket: "contract-s3", region: "us-east-1", forcePathStyle: true, publicBaseUrl: "https://cdn.test/" }, creds),
  fetchSignedUrls: true,
  directUpload: "fetchable",
  expectPublicUrl: true,
});

storageContract({
  name: "cloudflare r2 (RustFS endpoint)",
  make: () =>
    r2Storage.create(ctx({ accountId: "0123456789abcdef0123456789abcdef", bucket: "contract-r2", endpoint: s3Endpoint, publicBaseUrl: "https://pub-x.r2.dev" }, creds, "live")),
  fetchSignedUrls: true,
  directUpload: "fetchable",
  expectPublicUrl: true,
});

storageContract({
  name: "backblaze b2 (RustFS endpoint)",
  make: () => b2Storage.create(ctx({ region: "us-west-004", bucket: "contract-b2", endpoint: s3Endpoint }, creds, "live")),
  fetchSignedUrls: true,
  directUpload: "fetchable",
  expectPublicUrl: false,
});

storageContract({
  name: "azure blob (Azurite)",
  make: () =>
    azureBlobStorage.create(
      ctx({ accountName: AZURITE.account, container: "contract-azure", endpoint: azureEndpoint, publicBaseUrl: "https://cdn.test" }, { accountKey: AZURITE.key }, "live"),
    ),
  fetchSignedUrls: true,
  directUpload: "fetchable",
  expectPublicUrl: true,
});

describe("adapter-specific errors", () => {
  it("S3 family: bad credentials and missing buckets are readable", async () => {
    const bad = await s3CompatibleStorage
      .create(ctx({ endpoint: s3Endpoint, bucket: "contract-s3", region: "us-east-1", forcePathStyle: true }, { accessKeyId: "nope", secretAccessKey: "wrong-secret" }, "live"))
      .testCredentials();
    expect(bad).toMatchObject({ ok: false, error: expect.stringMatching(/Access denied/) });
    const missing = await r2Storage
      .create(ctx({ accountId: "0123456789abcdef0123456789abcdef", bucket: "nope-bucket", endpoint: s3Endpoint }, creds, "live"))
      .testCredentials();
    expect(missing).toEqual({ ok: false, error: "Bucket does not exist" });
  });

  it("AWS S3 has no endpoint field; R2 and B2 derive theirs", () => {
    expect(Object.keys((s3Storage.configSchema as unknown as { shape: object }).shape)).not.toContain("endpoint");
    expect(r2Storage.configSchema.safeParse({ accountId: "xyz", bucket: "abc" }).success).toBe(false);
    expect(b2Storage.configSchema.safeParse({ region: "us-west-004", bucket: "my-bucket" }).success).toBe(true);
  });

  it("Azure reports missing containers", async () => {
    const azMissing = await azureBlobStorage
      .create(ctx({ accountName: AZURITE.account, container: "nope-container", endpoint: azureEndpoint }, { accountKey: AZURITE.key }, "live"))
      .testCredentials();
    expect(azMissing).toMatchObject({ ok: false, error: "Container does not exist" });
  });

});
