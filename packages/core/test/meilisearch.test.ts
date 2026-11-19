import { GenericContainer, Wait, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createProduct, meiliSearch, searchStorefront, updateProduct } from "../src/index.js";
import { makeStore, teeInput } from "./catalog-fixtures.js";
import { ACTOR, makeDeps, type TestDeps } from "./harness.js";

/** The Meilisearch adapter behind SearchEngine (compose profile `meilisearch`). */
let meili: StartedTestContainer;
let deps: TestDeps;
let storeId: string;

beforeAll(async () => {
  meili = await new GenericContainer("getmeili/meilisearch:v1.27.0")
    .withEnvironment({ MEILI_MASTER_KEY: "test-master-key-123456", MEILI_NO_ANALYTICS: "true" })
    .withExposedPorts(7700)
    .withWaitStrategy(Wait.forHttp("/health", 7700))
    .start();
  deps = await makeDeps();
  await deps.reset();
  deps.search = meiliSearch(deps.db, { url: `http://${meili.getHost()}:${meili.getMappedPort(7700)}`, apiKey: "test-master-key-123456" });
  storeId = await makeStore(deps);
});
afterAll(async () => {
  await deps?.close();
  await meili?.stop();
});

describe("meilisearch engine", () => {
  it("indexes active products, follows updates and serves storefront search", async () => {
    const tee = await createProduct(deps, ACTOR, storeId, teeInput());
    await createProduct(deps, ACTOR, storeId, { title: "Draft tee", status: "draft", variants: [{ price: 1 }] });
    expect(await deps.search!.reindex(storeId)).toBe(1);
    const found = await searchStorefront(deps, storeId, "blcok print", { limit: 10 }); // typo tolerance (5+ letters)
    expect(found.items.map((p) => p.id)).toEqual([tee.id]);
    expect((await searchStorefront(deps, storeId, "TEE-M-Red", { limit: 10 })).total).toBe(1);

    await updateProduct(deps, ACTOR, storeId, tee.id, teeInput({ status: "archived" }));
    await deps.search!.sync(storeId, [tee.id]);
    expect((await searchStorefront(deps, storeId, "block", { limit: 10 })).items).toEqual([]);
  }, 60_000);
});
