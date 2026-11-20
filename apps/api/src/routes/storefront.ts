import {
  AppError,
  getInstallStore,
  getStorefrontCollection,
  getStorefrontProduct,
  listStorefrontCollections,
  listStorefrontProducts,
  searchStorefront,
  storefrontFacets,
  storeView,
} from "@shopkit/core";
import type { FastifyReply } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { AppDeps } from "../deps.js";
import { errorResponses, storefrontStore } from "../schemas.js";
import {
  productPageSchema,
  searchResultSchema,
  storefrontCollectionListSchema,
  storefrontCollectionSchema,
  storefrontFacetsSchema,
  storefrontListQuerySchema,
  storefrontProductSchema,
} from "../schemas-catalog.js";

const tags = ["storefront"];
const handleParams = z.object({ handle: z.string().min(1).max(255) });
/** Public catalog reads: short browser/CDN cache; the storefront's own cache is tag-revalidated. */
const CACHE = "public, max-age=30, stale-while-revalidate=300";

export const storefrontRoutes: FastifyPluginAsyncZod<{ deps: AppDeps }> = async (app, { deps }) => {
  async function activeStoreId(): Promise<string> {
    const store = await getInstallStore(deps.db);
    if (!store || store.status !== "active") throw new AppError("setup_required", "This shop is not open yet");
    return store.id;
  }
  const cache = (reply: FastifyReply) => reply.header("cache-control", CACHE);

  app.get(
    "/store",
    { schema: { tags, operationId: "getStorefrontStore", response: { 200: storefrontStore } } },
    async (_req, reply) => {
      const store = await getInstallStore(deps.db);
      cache(reply);
      if (!store || store.status !== "active") return { setupRequired: true, store: null };
      const view = await storeView(deps, store);
      return {
        setupRequired: false,
        store: {
          name: view.name,
          logoUrl: view.logoUrl,
          faviconUrl: view.faviconUrl,
          brand: view.brand,
          currency: view.currency,
          locale: view.locale,
          publicUrl: view.publicUrl,
          email: view.email,
          phone: view.phone,
          country: view.country,
          address: view.address,
        },
      };
    },
  );

  app.get(
    "/products",
    { schema: { tags, operationId: "listStorefrontProducts", querystring: storefrontListQuerySchema, response: { 200: productPageSchema, ...errorResponses } } },
    async (req, reply) => {
      const result = await listStorefrontProducts(deps, await activeStoreId(), req.query);
      cache(reply);
      return result;
    },
  );

  app.get(
    "/products/:handle",
    { schema: { tags, operationId: "getStorefrontProduct", params: handleParams, response: { 200: storefrontProductSchema, ...errorResponses } } },
    async (req, reply) => {
      const product = await getStorefrontProduct(deps, await activeStoreId(), req.params.handle.toLowerCase());
      if (!product) throw new AppError("not_found", "Product not found");
      cache(reply);
      return product;
    },
  );

  app.get(
    "/collections",
    {
      schema: {
        tags,
        operationId: "listStorefrontCollections",
        querystring: z.object({ limit: z.coerce.number().int().min(1).max(100).default(50), cursor: z.string().max(500).optional() }),
        response: { 200: storefrontCollectionListSchema, ...errorResponses },
      },
    },
    async (req, reply) => {
      const result = await listStorefrontCollections(deps, await activeStoreId(), req.query);
      cache(reply);
      return result;
    },
  );

  app.get(
    "/collections/:handle",
    { schema: { tags, operationId: "getStorefrontCollection", params: handleParams, response: { 200: storefrontCollectionSchema, ...errorResponses } } },
    async (req, reply) => {
      const collection = await getStorefrontCollection(deps, await activeStoreId(), req.params.handle.toLowerCase());
      if (!collection) throw new AppError("not_found", "Collection not found");
      cache(reply);
      return collection;
    },
  );

  app.get(
    "/collections/:handle/products",
    {
      schema: {
        tags,
        operationId: "listStorefrontCollectionProducts",
        params: handleParams,
        querystring: storefrontListQuerySchema,
        response: { 200: productPageSchema, ...errorResponses },
      },
    },
    async (req, reply) => {
      const storeId = await activeStoreId();
      const collection = await getStorefrontCollection(deps, storeId, req.params.handle.toLowerCase());
      if (!collection) throw new AppError("not_found", "Collection not found");
      const result = await listStorefrontProducts(deps, storeId, req.query, { id: collection.id, sortOrder: collection.sortOrder });
      cache(reply);
      return result;
    },
  );

  app.get(
    "/facets",
    {
      schema: {
        tags,
        operationId: "getStorefrontFacets",
        querystring: z.object({ collection: z.string().min(1).max(255).optional() }),
        response: { 200: storefrontFacetsSchema, ...errorResponses },
      },
    },
    async (req, reply) => {
      const storeId = await activeStoreId();
      let collectionId: string | undefined;
      if (req.query.collection) {
        const c = await getStorefrontCollection(deps, storeId, req.query.collection.toLowerCase());
        if (!c) throw new AppError("not_found", "Collection not found");
        collectionId = c.id;
      }
      const result = await storefrontFacets(deps, storeId, collectionId);
      cache(reply);
      return result;
    },
  );

  app.get(
    "/search",
    {
      config: { rateLimit: { max: 120, timeWindow: "1 minute" } },
      schema: {
        tags,
        operationId: "searchStorefront",
        querystring: z.object({ q: z.string().trim().min(1).max(200), limit: z.coerce.number().int().min(1).max(50).default(24), cursor: z.string().max(200).optional() }),
        response: { 200: searchResultSchema, ...errorResponses },
      },
    },
    async (req, reply) => {
      const result = await searchStorefront(deps, await activeStoreId(), req.query.q, { limit: req.query.limit, cursor: req.query.cursor });
      cache(reply);
      return result;
    },
  );
};
