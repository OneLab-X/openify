import {
  addProductsToCollection,
  adjustInventory,
  adjustmentInput,
  AppError,
  bulkProductInput,
  bulkUpdateProducts,
  catalogFacets,
  collectionInput,
  completeMediaUpload,
  createCollection,
  createLocation,
  createMediaUpload,
  createMetafieldDefinition,
  createProduct,
  createSavedView,
  deleteCollection,
  deleteMedia,
  deleteMetafieldDefinition,
  deleteProduct,
  deleteSavedView,
  getCollectionAdmin,
  getJob,
  getProductAdmin,
  inventoryListQuery,
  jobErrorsCsv,
  jobView,
  listAdjustments,
  listCollectionsAdmin,
  listInventory,
  listJobs,
  listLocations,
  listMetafieldDefinitions,
  listProductsAdmin,
  listSavedViews,
  locationInput,
  mediaUploadInput,
  metafieldDefinitionInput,
  productInput,
  readExport,
  savedViewInput,
  startMediaMigration,
  startProductExport,
  startProductImport,
  updateCollection,
  updateLocation,
  updateMediaAlt,
  updateProduct,
  uploadMedia,
} from "@shopkit/core";
import type { Address } from "@shopkit/db";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { AppDeps } from "../deps.js";
import { actorOf, requireStaff } from "../plugins/auth.js";
import { errorResponses, okBody } from "../schemas.js";
import {
  adjustmentSchema,
  collectionAdminSchema,
  collectionListSchema,
  facetsSchema,
  inventoryPageSchema,
  jobSchema,
  locationSchema,
  mediaViewSchema,
  metafieldDefinitionSchema,
  productAdminSchema,
  productListQuerySchema,
  productListSchema,
  savedViewSchema,
  uploadTargetSchema,
} from "../schemas-catalog.js";
import { readUpload } from "./uploads.js";

const tags = ["admin"];
const idParams = z.object({ id: z.uuid() });
/** Products with many variants exceed the default 1 MB JSON limit. */
const LARGE_BODY = 8 * 1024 * 1024;

export const catalogRoutes: FastifyPluginAsyncZod<{ deps: AppDeps }> = async (app, { deps }) => {
  const read = requireStaff(deps, "products:read");
  const write = requireStaff(deps, "products:write");
  const sid = (req: { staff?: { storeId: string } }) => req.staff!.storeId;

  // ── Products ───────────────────────────────────────────────────────────────
  app.get(
    "/products",
    { onRequest: read, schema: { tags, operationId: "listProducts", querystring: productListQuerySchema, response: { 200: productListSchema, ...errorResponses } } },
    (req) => listProductsAdmin(deps, sid(req), req.query),
  );
  app.post(
    "/products",
    { onRequest: write, bodyLimit: LARGE_BODY, schema: { tags, operationId: "createProduct", body: productInput, response: { 200: productAdminSchema, ...errorResponses } } },
    (req) => createProduct(deps, actorOf(req), sid(req), req.body),
  );
  app.get(
    "/products/:id",
    { onRequest: read, schema: { tags, operationId: "getProduct", params: idParams, response: { 200: productAdminSchema, ...errorResponses } } },
    (req) => getProductAdmin(deps, sid(req), req.params.id),
  );
  app.put(
    "/products/:id",
    {
      onRequest: write,
      bodyLimit: LARGE_BODY,
      schema: { tags, operationId: "updateProduct", params: idParams, body: productInput, response: { 200: productAdminSchema, ...errorResponses } },
    },
    (req) => updateProduct(deps, actorOf(req), sid(req), req.params.id, req.body),
  );
  app.delete(
    "/products/:id",
    { onRequest: write, schema: { tags, operationId: "deleteProduct", params: idParams, response: { 200: okBody, ...errorResponses } } },
    async (req) => {
      await deleteProduct(deps, actorOf(req), sid(req), req.params.id);
      return { ok: true as const };
    },
  );
  app.post(
    "/products/bulk",
    { onRequest: write, schema: { tags, operationId: "bulkProducts", body: bulkProductInput, response: { 200: z.object({ updated: z.number().int() }), ...errorResponses } } },
    (req) => bulkUpdateProducts(deps, actorOf(req), sid(req), req.body),
  );
  app.get(
    "/catalog/facets",
    { onRequest: read, schema: { tags, operationId: "getCatalogFacets", response: { 200: facetsSchema } } },
    (req) => catalogFacets(deps.db, sid(req)),
  );

  // ── Saved views ────────────────────────────────────────────────────────────
  const viewOut = (v: { id: string; name: string; filters: Record<string, unknown>; createdAt: Date }) => ({ id: v.id, name: v.name, filters: v.filters, createdAt: v.createdAt.toISOString() });
  app.get(
    "/product-views",
    { onRequest: read, schema: { tags, operationId: "listProductViews", response: { 200: z.array(savedViewSchema) } } },
    async (req) => (await listSavedViews(deps.db, sid(req))).map(viewOut),
  );
  app.post(
    "/product-views",
    { onRequest: read, schema: { tags, operationId: "saveProductView", body: savedViewInput, response: { 200: savedViewSchema, ...errorResponses } } },
    async (req) => viewOut(await createSavedView(deps.db, actorOf(req), sid(req), req.body)),
  );
  app.delete(
    "/product-views/:id",
    { onRequest: read, schema: { tags, operationId: "deleteProductView", params: idParams, response: { 200: okBody } } },
    async (req) => {
      await deleteSavedView(deps.db, sid(req), req.params.id);
      return { ok: true as const };
    },
  );

  // ── Media ──────────────────────────────────────────────────────────────────
  app.post(
    "/media/uploads",
    { onRequest: write, schema: { tags, operationId: "createMediaUpload", body: mediaUploadInput, response: { 200: uploadTargetSchema, ...errorResponses } } },
    (req) => createMediaUpload(deps, actorOf(req), sid(req), req.body),
  );
  app.post(
    "/media/:id/complete",
    { onRequest: write, schema: { tags, operationId: "completeMediaUpload", params: idParams, response: { 200: mediaViewSchema, ...errorResponses } } },
    (req) => completeMediaUpload(deps, actorOf(req), sid(req), req.params.id),
  );
  app.post(
    "/media",
    { onRequest: write, schema: { tags, operationId: "uploadMedia", consumes: ["multipart/form-data"], response: { 200: mediaViewSchema, ...errorResponses } } },
    async (req) => uploadMedia(deps, actorOf(req), sid(req), await readUpload(req)),
  );
  app.patch(
    "/media/:id",
    {
      onRequest: write,
      schema: { tags, operationId: "updateMedia", params: idParams, body: z.object({ alt: z.string().max(512).nullable() }), response: { 200: mediaViewSchema, ...errorResponses } },
    },
    (req) => updateMediaAlt(deps, actorOf(req), sid(req), req.params.id, req.body.alt),
  );
  app.delete(
    "/media/:id",
    { onRequest: write, schema: { tags, operationId: "deleteMedia", params: idParams, response: { 200: okBody, ...errorResponses } } },
    async (req) => {
      await deleteMedia(deps, actorOf(req), sid(req), req.params.id);
      return { ok: true as const };
    },
  );

  // ── Collections ────────────────────────────────────────────────────────────
  app.get(
    "/collections",
    {
      onRequest: read,
      schema: {
        tags,
        operationId: "listCollections",
        querystring: z.object({ q: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(250).default(100), offset: z.coerce.number().int().min(0).default(0) }),
        response: { 200: collectionListSchema },
      },
    },
    (req) => listCollectionsAdmin(deps, sid(req), req.query),
  );
  app.post(
    "/collections",
    { onRequest: write, bodyLimit: LARGE_BODY, schema: { tags, operationId: "createCollection", body: collectionInput, response: { 200: collectionAdminSchema, ...errorResponses } } },
    (req) => createCollection(deps, actorOf(req), sid(req), req.body),
  );
  app.get(
    "/collections/:id",
    { onRequest: read, schema: { tags, operationId: "getCollection", params: idParams, response: { 200: collectionAdminSchema, ...errorResponses } } },
    (req) => getCollectionAdmin(deps, sid(req), req.params.id),
  );
  app.put(
    "/collections/:id",
    {
      onRequest: write,
      bodyLimit: LARGE_BODY,
      schema: { tags, operationId: "updateCollection", params: idParams, body: collectionInput, response: { 200: collectionAdminSchema, ...errorResponses } },
    },
    (req) => updateCollection(deps, actorOf(req), sid(req), req.params.id, req.body),
  );
  app.delete(
    "/collections/:id",
    { onRequest: write, schema: { tags, operationId: "deleteCollection", params: idParams, response: { 200: okBody, ...errorResponses } } },
    async (req) => {
      await deleteCollection(deps, actorOf(req), sid(req), req.params.id);
      return { ok: true as const };
    },
  );
  app.post(
    "/collections/:id/products",
    {
      onRequest: write,
      schema: { tags, operationId: "addCollectionProducts", params: idParams, body: z.object({ productIds: z.array(z.uuid()).min(1).max(500) }), response: { 200: okBody, ...errorResponses } },
    },
    async (req) => {
      await addProductsToCollection(deps, actorOf(req), sid(req), req.params.id, req.body.productIds);
      return { ok: true as const };
    },
  );

  // ── Locations and inventory ────────────────────────────────────────────────
  const locOut = (l: { id: string; name: string; address: Address; isDefault: boolean; active: boolean }) => ({
    id: l.id,
    name: l.name,
    address: l.address,
    isDefault: l.isDefault,
    active: l.active,
  });
  app.get(
    "/locations",
    { onRequest: read, schema: { tags, operationId: "listLocations", response: { 200: z.array(locationSchema) } } },
    async (req) => (await listLocations(deps.db, sid(req))).map(locOut),
  );
  app.post(
    "/locations",
    { onRequest: write, schema: { tags, operationId: "createLocation", body: locationInput, response: { 200: locationSchema, ...errorResponses } } },
    async (req) => locOut(await createLocation(deps, actorOf(req), sid(req), req.body)),
  );
  app.put(
    "/locations/:id",
    {
      onRequest: write,
      schema: { tags, operationId: "updateLocation", params: idParams, body: locationInput.extend({ isDefault: z.boolean().optional() }), response: { 200: locationSchema, ...errorResponses } },
    },
    async (req) => locOut(await updateLocation(deps, actorOf(req), sid(req), req.params.id, req.body)),
  );
  app.get(
    "/inventory",
    { onRequest: read, schema: { tags, operationId: "listInventory", querystring: inventoryListQuery, response: { 200: inventoryPageSchema, ...errorResponses } } },
    (req) => listInventory(deps.db, sid(req), req.query),
  );
  app.post(
    "/inventory/adjustments",
    {
      onRequest: write,
      schema: { tags, operationId: "adjustInventory", body: adjustmentInput, response: { 200: z.object({ productIds: z.array(z.uuid()) }), ...errorResponses } },
    },
    (req) => adjustInventory(deps, actorOf(req), sid(req), { reason: req.body.reason, note: req.body.note, changes: req.body.changes }),
  );
  app.get(
    "/inventory/items/:id/adjustments",
    {
      onRequest: read,
      schema: {
        tags,
        operationId: "listInventoryAdjustments",
        params: idParams,
        querystring: z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) }),
        response: { 200: z.array(adjustmentSchema) },
      },
    },
    async (req) =>
      (await listAdjustments(deps.db, sid(req), req.params.id, { limit: req.query.limit })).map((a) => ({ ...a, createdAt: a.createdAt.toISOString() })),
  );

  // ── Metafield definitions ──────────────────────────────────────────────────
  const defOut = (d: { id: string; ownerType: "product" | "variant" | "collection"; namespace: string; key: string; name: string; type: string; description: string | null }) => ({
    id: d.id,
    ownerType: d.ownerType,
    namespace: d.namespace,
    key: d.key,
    name: d.name,
    type: d.type,
    description: d.description,
  });
  app.get(
    "/metafield-definitions",
    {
      onRequest: read,
      schema: {
        tags,
        operationId: "listMetafieldDefinitions",
        querystring: z.object({ ownerType: z.enum(["product", "variant", "collection"]).optional() }),
        response: { 200: z.array(metafieldDefinitionSchema) },
      },
    },
    async (req) => (await listMetafieldDefinitions(deps.db, sid(req), req.query.ownerType)).map(defOut),
  );
  app.post(
    "/metafield-definitions",
    { onRequest: write, schema: { tags, operationId: "createMetafieldDefinition", body: metafieldDefinitionInput, response: { 200: metafieldDefinitionSchema, ...errorResponses } } },
    async (req) => defOut(await createMetafieldDefinition(deps.db, sid(req), req.body)),
  );
  app.delete(
    "/metafield-definitions/:id",
    { onRequest: write, schema: { tags, operationId: "deleteMetafieldDefinition", params: idParams, response: { 200: okBody } } },
    async (req) => {
      await deleteMetafieldDefinition(deps.db, sid(req), req.params.id);
      return { ok: true as const };
    },
  );

  // ── Import / export / media migration jobs ─────────────────────────────────
  app.post(
    "/products/import",
    {
      onRequest: write,
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: { tags, operationId: "importProducts", consumes: ["multipart/form-data"], response: { 200: jobSchema, ...errorResponses } },
    },
    async (req) => {
      const file = await readUpload(req, "The CSV must be 20 MB or smaller");
      return startProductImport(deps, actorOf(req), sid(req), file);
    },
  );
  app.post(
    "/products/export",
    {
      onRequest: read,
      schema: { tags, operationId: "exportProducts", body: z.object({ filter: productListQuerySchema.omit({ cursor: true, limit: true, sort: true }).default({}) }), response: { 200: jobSchema, ...errorResponses } },
    },
    (req) => startProductExport(deps, actorOf(req), sid(req), req.body.filter),
  );
  app.post(
    "/storage/migrate",
    {
      onRequest: requireStaff(deps, "settings:storage"),
      schema: { tags, operationId: "migrateMedia", body: z.object({ provider: z.string().min(1).max(64), mode: z.enum(["test", "live"]).default("live") }), response: { 200: jobSchema, ...errorResponses } },
    },
    (req) => startMediaMigration(deps, actorOf(req), sid(req), req.body),
  );
  app.get(
    "/jobs",
    {
      onRequest: read,
      schema: {
        tags,
        operationId: "listJobs",
        querystring: z.object({ type: z.enum(["product_import", "product_export", "media_migration"]).optional() }),
        response: { 200: z.array(jobSchema) },
      },
    },
    (req) => listJobs(deps, sid(req), req.query.type),
  );
  app.get(
    "/jobs/:id",
    { onRequest: read, schema: { tags, operationId: "getJob", params: idParams, response: { 200: jobSchema, ...errorResponses } } },
    async (req) => {
      const row = await getJob(deps, sid(req), req.params.id);
      return { ...jobView(row), errors: row.errors.slice(0, 50) };
    },
  );
  app.get(
    "/jobs/:id/errors.csv",
    { onRequest: read, schema: { tags, operationId: "downloadJobErrors", params: idParams, produces: ["text/csv"] } },
    async (req, reply) => {
      const row = await getJob(deps, sid(req), req.params.id);
      return reply
        .header("content-type", "text/csv; charset=utf-8")
        .header("content-disposition", `attachment; filename="${row.type}-${row.id}-errors.csv"`)
        .send(jobErrorsCsv(row));
    },
  );
  app.get(
    "/jobs/:id/download",
    { onRequest: read, schema: { tags, operationId: "downloadExport", params: idParams, produces: ["text/csv"] } },
    async (req, reply) => {
      const { object, filename } = await readExport(deps, sid(req), req.params.id);
      if (!/^[\w.-]+$/.test(filename)) throw new AppError("bad_request", "Invalid file name");
      reply.header("content-type", "text/csv; charset=utf-8").header("content-disposition", `attachment; filename="${filename}"`).header("cache-control", "private, no-store");
      if (object.contentLength !== undefined) reply.header("content-length", object.contentLength);
      return reply.send(object.body);
    },
  );
};
