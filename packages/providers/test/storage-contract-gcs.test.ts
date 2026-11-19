import { generateKeyPairSync } from "node:crypto";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { gcsStorage } from "../src/storage/gcs.js";
import { ctx } from "./helpers.js";
import { storageContract } from "./storage-contract.js";

/**
 * Google Cloud Storage against fake-gcs-server. The SDK always fetches an OAuth token from Google, so
 * that one endpoint is mocked; every storage call goes to the emulator unmodified.
 */
const tokens = setupServer(
  http.post("https://oauth2.googleapis.com/token", () => HttpResponse.json({ access_token: "emulator-token", expires_in: 3600, token_type: "Bearer" })),
);

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const serviceAccountJson = JSON.stringify({
  type: "service_account",
  project_id: "shopkit-test",
  client_email: "shopkit@shopkit-test.iam.gserviceaccount.com",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
});

let gcs: StartedTestContainer;
let endpoint = "";

beforeAll(async () => {
  tokens.listen({ onUnhandledFrame: "bypass" });
  gcs = await new GenericContainer("fsouza/fake-gcs-server:1.52.3")
    .withCommand(["-scheme", "http", "-port", "4443"])
    .withExposedPorts(4443)
    .withWaitStrategy(Wait.forHttp("/storage/v1/b", 4443))
    .start();
  endpoint = `http://${gcs.getHost()}:${gcs.getMappedPort(4443)}`;
  const created = await fetch(`${endpoint}/storage/v1/b?project=shopkit-test`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "contract-gcs" }),
  });
  expect(created.ok).toBe(true);
});
afterAll(async () => {
  tokens.close();
  await gcs?.stop();
});

storageContract({
  name: "google cloud storage (fake-gcs-server)",
  make: () => gcsStorage.create(ctx({ bucket: "contract-gcs", apiEndpoint: endpoint, publicBaseUrl: "https://storage.googleapis.com/contract-gcs" }, { serviceAccountJson }, "live")),
  // fake-gcs-server only serves path-style XML downloads for its configured public host.
  fetchSignedUrls: false,
  directUpload: "present",
  expectPublicUrl: true,
});

describe("gcs errors", () => {
  it("reports a missing bucket", async () => {
    const res = await gcsStorage.create(ctx({ bucket: "nope-bucket", apiEndpoint: endpoint }, { serviceAccountJson }, "live")).testCredentials();
    expect(res).toMatchObject({ ok: false });
  });

  it("signs V4 URLs with the service account", async () => {
    const p = gcsStorage.create(ctx({ bucket: "contract-gcs", apiEndpoint: endpoint }, { serviceAccountJson }, "live"));
    const url = new URL(await p.getSignedUrl("a b.png", { expiresIn: 60 }));
    expect(url.pathname).toBe("/contract-gcs/a%20b.png");
    expect(url.searchParams.get("X-Goog-Algorithm")).toBe("GOOG4-RSA-SHA256");
    expect(url.searchParams.get("X-Goog-Expires")).toBe("60");
    const up = await p.createUploadUrl!("a.png", { contentType: "image/png", expiresIn: 60 });
    expect(new URL(up.url).searchParams.get("X-Goog-SignedHeaders")).toContain("content-type");
  });

  it("service-account secrets must be a key file", () => {
    expect(gcsStorage.secretsSchema.safeParse({ serviceAccountJson: "{not json" }).success).toBe(false);
    expect(gcsStorage.secretsSchema.safeParse({ serviceAccountJson }).success).toBe(true);
  });
});
