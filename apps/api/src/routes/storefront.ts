import { getInstallStore, storeView } from "@shopkit/core";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import type { AppDeps } from "../deps.js";
import { storefrontStore } from "../schemas.js";

export const storefrontRoutes: FastifyPluginAsyncZod<{ deps: AppDeps }> = async (app, { deps }) => {
  app.get(
    "/store",
    { schema: { tags: ["storefront"], operationId: "getStorefrontStore", response: { 200: storefrontStore } } },
    async (_req, reply) => {
      const store = await getInstallStore(deps.db);
      reply.header("cache-control", "public, max-age=30, stale-while-revalidate=300");
      if (!store || store.status !== "active") return { setupRequired: true, store: null };
      const view = await storeView(deps, store);
      return {
        setupRequired: false,
        store: { name: view.name, logoUrl: view.logoUrl, faviconUrl: view.faviconUrl, brand: view.brand, currency: view.currency, locale: view.locale },
      };
    },
  );
};
