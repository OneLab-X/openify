import {
  AppError,
  deleteCredential,
  enqueueEvent,
  getSetting,
  getStore,
  listAudit,
  listCredentials,
  listStaff,
  sendTestEmail,
  setSetting,
  SETTINGS,
  storeDetailsSchema,
  storeView,
  testCredential,
  updateStoreDetails,
  upsertCredential,
  uploadBrandAsset,
  writeAudit,
  type Permission,
} from "@shopkit/core";
import type { ProviderKind } from "@shopkit/providers";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { AppDeps } from "../deps.js";
import { actorOf, requireStaff } from "../plugins/auth.js";
import {
  auditEntry,
  credentialBody,
  credentialSummary,
  errorResponses,
  okBody,
  providerDescriptor,
  providerKind,
  providerMode,
  settingsView,
  staffView,
  storeView as storeViewSchema,
  testResult,
} from "../schemas.js";
import { readUpload } from "./uploads.js";

const tags = ["admin"];

const KIND_PERMISSION: Record<ProviderKind, Permission> = {
  payment: "settings:payments",
  storage: "settings:storage",
  email: "settings:email",
  analytics: "settings:analytics",
  shipping: "settings:shipping",
};

const SETTING_PERMISSION: Record<keyof typeof SETTINGS, Permission> = {
  "storage.active": "settings:storage",
  "email.active": "settings:email",
  "analytics.consentBanner": "settings:analytics",
  "payments.mode": "settings:payments",
  "shipping.defaults": "settings:shipping",
  "tax.config": "settings:tax",
    "security.config": "settings:security",
  "checkout.config": "settings:general",
  "notifications.config": "settings:email",
  "notifications.templates": "settings:email",
};

export const adminRoutes: FastifyPluginAsyncZod<{ deps: AppDeps }> = async (app, { deps }) => {
  const credentialParams = z.object({ kind: providerKind, provider: z.string().min(1).max(64), mode: providerMode });

  /** Permission depends on the provider kind in the URL, so it is checked after the session. */
  function assertCan(perms: string[], perm: Permission) {
    if (!perms.includes("*") && !perms.includes(perm)) throw new AppError("forbidden", "You do not have permission to do that");
  }

  app.get(
    "/store",
    { onRequest: requireStaff(deps, "settings:read"), schema: { tags, operationId: "getStore", response: { 200: storeViewSchema, ...errorResponses } } },
    async (req) => storeView(deps, await getStore(deps.db, req.staff!.storeId)),
  );

  app.put(
    "/store",
    {
      onRequest: requireStaff(deps, "settings:general"),
      schema: { tags, operationId: "updateStore", body: storeDetailsSchema, response: { 200: storeViewSchema, ...errorResponses } },
    },
    async (req) => {
      const storeId = req.staff!.storeId;
      await deps.db.transaction(async (tx) => {
        await updateStoreDetails(tx, storeId, req.body);
        await enqueueEvent(tx, { storeId, type: "store.updated" });
        await writeAudit(tx, actorOf(req), { storeId, action: "store.details_updated", resourceType: "store", resourceId: storeId });
      });
      return storeView(deps, await getStore(deps.db, storeId));
    },
  );

  app.post(
    "/store/:asset",
    {
      onRequest: requireStaff(deps, "settings:general"),
      schema: {
        tags,
        operationId: "uploadBrandAsset",
        consumes: ["multipart/form-data"],
        params: z.object({ asset: z.enum(["logo", "favicon"]) }),
        response: { 200: z.object({ id: z.uuid(), url: z.string() }), ...errorResponses },
      },
    },
    async (req) => {
      const row = await uploadBrandAsset(deps, actorOf(req), req.staff!.storeId, req.params.asset, await readUpload(req));
      return { id: row.id, url: `${deps.runtime.publicUrl}/media/${row.id}/${encodeURIComponent(row.filename)}` };
    },
  );

  app.get(
    "/providers",
    {
      onRequest: requireStaff(deps, "settings:read"),
      schema: { tags, operationId: "listProviders", querystring: z.object({ kind: providerKind.optional() }), response: { 200: z.array(providerDescriptor) } },
    },
    (req) => deps.registry.describe(req.query.kind),
  );

  app.get(
    "/credentials",
    {
      onRequest: requireStaff(deps, "settings:read"),
      schema: { tags, operationId: "listCredentials", querystring: z.object({ kind: providerKind.optional() }), response: { 200: z.array(credentialSummary) } },
    },
    (req) => listCredentials(deps, req.staff!.storeId, req.query.kind),
  );

  app.put(
    "/credentials/:kind/:provider/:mode",
    {
      onRequest: requireStaff(deps),
      schema: { tags, operationId: "saveCredential", params: credentialParams, body: credentialBody, response: { 200: credentialSummary, ...errorResponses } },
    },
    (req) => {
      assertCan(req.staff!.permissions, KIND_PERMISSION[req.params.kind]);
      return upsertCredential(deps, actorOf(req), { storeId: req.staff!.storeId, ...req.params }, req.body);
    },
  );

  app.post(
    "/credentials/:kind/:provider/:mode/test",
    {
      onRequest: requireStaff(deps),
      schema: { tags, operationId: "testCredential", params: credentialParams, body: credentialBody, response: { 200: testResult, ...errorResponses } },
    },
    (req) => {
      assertCan(req.staff!.permissions, KIND_PERMISSION[req.params.kind]);
      return testCredential(deps, { storeId: req.staff!.storeId, ...req.params }, req.body);
    },
  );

  app.delete(
    "/credentials/:kind/:provider/:mode",
    {
      onRequest: requireStaff(deps),
      schema: { tags, operationId: "deleteCredential", params: credentialParams, response: { 200: okBody, ...errorResponses } },
    },
    async (req) => {
      assertCan(req.staff!.permissions, KIND_PERMISSION[req.params.kind]);
      const storeId = req.staff!.storeId;
      const active = await getSetting(deps.db, storeId, "storage.active");
      if (req.params.kind === "storage" && active.provider === req.params.provider) {
        throw new AppError("conflict", "Choose another storage provider before removing the active one");
      }
      await deleteCredential(deps, actorOf(req), { storeId, ...req.params });
      return { ok: true as const };
    },
  );

  app.get(
    "/settings",
    { onRequest: requireStaff(deps, "settings:read"), schema: { tags, operationId: "getSettings", response: { 200: settingsView } } },
    async (req) => {
      const id = req.staff!.storeId;
      return {
        storage: await getSetting(deps.db, id, "storage.active"),
        email: await getSetting(deps.db, id, "email.active"),
        paymentsMode: await getSetting(deps.db, id, "payments.mode"),
        consentBanner: await getSetting(deps.db, id, "analytics.consentBanner"),
        shipping: await getSetting(deps.db, id, "shipping.defaults"),
        tax: await getSetting(deps.db, id, "tax.config"),
        checkout: await getSetting(deps.db, id, "checkout.config"),
        notifications: await getSetting(deps.db, id, "notifications.config"),
      };
    },
  );

  app.put(
    "/settings/:key",
    {
      onRequest: requireStaff(deps),
      schema: {
        tags,
        operationId: "updateSetting",
        params: z.object({ key: z.enum(Object.keys(SETTINGS) as [keyof typeof SETTINGS]) }),
        body: z.object({ value: z.unknown() }),
        response: { 200: okBody, ...errorResponses },
      },
    },
    async (req) => {
      const { key } = req.params;
      assertCan(req.staff!.permissions, SETTING_PERMISSION[key]);
      const value = SETTINGS[key].parse(req.body.value);
      const storeId = req.staff!.storeId;
      if (key === "storage.active" || key === "email.active") {
        const target = value as { provider: string; mode: "test" | "live" } | null;
        const kind = key === "storage.active" ? "storage" : "email";
        if (target && !(await listCredentials(deps, storeId, kind)).some((c) => c.provider === target.provider && c.mode === target.mode && c.enabled)) {
          throw new AppError("validation_failed", "Save and enable that provider first");
        }
      }
      await deps.db.transaction(async (tx) => {
        await setSetting(tx, storeId, key, value as never);
        await writeAudit(tx, actorOf(req), { storeId, action: "settings.updated", resourceType: "setting", resourceId: key });
      });
      return { ok: true as const };
    },
  );

  app.post(
    "/email/test-send",
    {
      onRequest: requireStaff(deps, "settings:email"),
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
      schema: {
        tags,
        operationId: "sendTestEmail",
        body: z.object({ provider: z.string(), mode: providerMode, to: z.email() }),
        response: { 200: testResult, ...errorResponses },
      },
    },
    (req) => sendTestEmail(deps, { storeId: req.staff!.storeId, provider: req.body.provider, mode: req.body.mode }, req.body.to),
  );

  app.get(
    "/staff",
    { onRequest: requireStaff(deps, "settings:read"), schema: { tags, operationId: "listStaff", response: { 200: z.array(staffView) } } },
    (req) => listStaff(deps.db, req.staff!.storeId),
  );

  app.get(
    "/audit-logs",
    {
      onRequest: requireStaff(deps, "audit:read"),
      schema: {
        tags,
        operationId: "listAuditLogs",
        querystring: z.object({ limit: z.coerce.number().int().min(1).max(100).default(50), cursor: z.uuid().optional() }),
        response: { 200: z.object({ items: z.array(auditEntry), nextCursor: z.uuid().nullable() }) },
      },
    },
    async (req) => {
      const page = await listAudit(deps.db, req.staff!.storeId, req.query);
      return {
        nextCursor: page.nextCursor,
        items: page.items.map((a) => ({
          id: a.id,
          actorType: a.actorType,
          actorId: a.actorId,
          action: a.action,
          resourceType: a.resourceType,
          resourceId: a.resourceId,
          ip: a.ip,
          metadata: a.metadata,
          createdAt: a.createdAt.toISOString(),
        })),
      };
    },
  );
};
