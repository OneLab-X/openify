import {
  AppError,
  acceptInvite,
  acceptInviteInput,
  approveReturn,
  auditQuery,
  calculateRefund,
  cancelFulfillment,
  cancelReturn,
  createFulfillment,
  dashboardCards,
  declineReturn,
  declineReturnInput,
  deleteRate,
  deleteRole,
  deleteTaxOverride,
  deleteTaxRate,
  deleteZone,
  describeInvite,
  fulfillmentInput,
  fulfillmentLabel,
  getGiftCard,
  getInvoice,
  getOrderAdmin,
  inviteInput,
  inviteStaff,
  issueGiftCard,
  issueGiftCardInput,
  listAllReturns,
  listCredentials,
  listGiftCards,
  listInvites,
  listRoles,
  listShipping,
  listTax,
  listTeam,
  PERMISSION_GROUPS,
  rateInput,
  receiveReturn,
  receiveReturnInput,
  refundInput,
  renderInvoicePdf,
  reportCsv,
  reportExportQuery,
  reportQuery,
  requestReturn,
  resolveReturn,
  resolveReturnInput,
  returnRequestInput,
  revokeInvite,
  roleInput,
  salesReport,
  saveRate,
  saveRole,
  saveTaxOverride,
  saveTaxRate,
  saveZone,
  searchAudit,
  securityInput,
  staffUpdateInput,
  taxOverrideInput,
  taxRateInput,
  trackingUpdateInput,
  updateFulfillmentTracking,
  updateGiftCard,
  updateGiftCardInput,
  updateSecurity,
  updateStaffMember,
  whatsappDeliveryLink,
  zoneInput,
} from "@shopkit/core";
import { and, eq, returns } from "@shopkit/db";
import { KNOWN_COURIERS } from "@shopkit/providers";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { AppDeps } from "../deps.js";
import { actorOf, requireStaff } from "../plugins/auth.js";
import { errorResponses, okBody } from "../schemas.js";
import { orderAdminSchema } from "../schemas-commerce.js";
import {
  auditPageSchema,
  couriersSchema,
  dashboardSchema,
  giftCardDetailSchema,
  giftCardIssuedSchema,
  giftCardSchema,
  inviteInfoSchema,
  inviteSchema,
  permissionGroupsSchema,
  refundCalculationSchema,
  returnListSchema,
  roleSchema,
  salesReportSchema,
  shippingSettingsSchema,
  taxSettingsSchema,
  teamMemberSchema,
} from "../schemas-operations.js";

const tags = ["admin"];
const ok = { ok: true as const };
const idParams = z.object({ id: z.uuid() });
const fulfillmentParams = z.object({ id: z.uuid(), fulfillmentId: z.uuid() });
const returnStatus = z.enum(["requested", "approved", "declined", "received", "closed", "cancelled"]);

/**
 * Phase 4 admin endpoints: fulfillments, refunds calculation, returns, invoices, shipping zones,
 * tax rates, gift cards, reports and the dashboard, roles, invitations, 2FA policy and audit log.
 */
export const operationsRoutes: FastifyPluginAsyncZod<{ deps: AppDeps }> = async (app, { deps }) => {
  const sid = (req: { staff?: { storeId: string } }) => req.staff!.storeId;
  const can = (p: Parameters<typeof requireStaff>[1]) => requireStaff(deps, p);
  const order = (req: { staff?: { storeId: string } }, id: string) => getOrderAdmin(deps, sid(req), id);

  // ── Fulfillments ───────────────────────────────────────────────────────────
  app.get("/couriers", { onRequest: can("orders:read"), schema: { tags, operationId: "listCouriers", response: { 200: couriersSchema, ...errorResponses } } }, async (req) => {
    const creds = await listCredentials(deps, sid(req), "shipping");
    const carriers = [...new Set(creds.filter((c) => c.enabled).map((c) => c.provider))].map((id) => ({ id, displayName: deps.registry.get("shipping", id)?.displayName ?? id }));
    return { couriers: KNOWN_COURIERS.map((c) => ({ id: c.id, name: c.name, country: c.country })), carriers };
  });
  app.post(
    "/orders/:id/fulfillments",
    { onRequest: can("orders:fulfill"), schema: { tags, operationId: "createFulfillment", params: idParams, body: fulfillmentInput, response: { 200: orderAdminSchema, ...errorResponses } } },
    async (req) => {
      await createFulfillment(deps, actorOf(req), sid(req), req.params.id, req.body);
      return order(req, req.params.id);
    },
  );
  app.patch(
    "/orders/:id/fulfillments/:fulfillmentId",
    {
      onRequest: can("orders:fulfill"),
      schema: { tags, operationId: "updateFulfillment", params: fulfillmentParams, body: trackingUpdateInput, response: { 200: orderAdminSchema, ...errorResponses } },
    },
    async (req) => {
      await updateFulfillmentTracking(deps, actorOf(req), sid(req), req.params.id, req.params.fulfillmentId, req.body);
      return order(req, req.params.id);
    },
  );
  app.post(
    "/orders/:id/fulfillments/:fulfillmentId/cancel",
    { onRequest: can("orders:fulfill"), schema: { tags, operationId: "cancelFulfillment", params: fulfillmentParams, response: { 200: orderAdminSchema, ...errorResponses } } },
    async (req) => {
      await cancelFulfillment(deps, actorOf(req), sid(req), req.params.id, req.params.fulfillmentId);
      return order(req, req.params.id);
    },
  );
  app.post(
    "/orders/:id/fulfillments/:fulfillmentId/whatsapp",
    {
      onRequest: can("orders:fulfill"),
      schema: { tags, operationId: "fulfillmentWhatsapp", params: fulfillmentParams, response: { 200: z.object({ url: z.string(), text: z.string() }), ...errorResponses } },
    },
    (req) => whatsappDeliveryLink(deps, actorOf(req), sid(req), req.params.id, req.params.fulfillmentId),
  );
  app.get(
    "/orders/:id/fulfillments/:fulfillmentId/label",
    { onRequest: can("orders:fulfill"), schema: { tags, operationId: "fulfillmentLabel", params: fulfillmentParams, response: { 200: z.object({ url: z.string().nullable() }), ...errorResponses } } },
    (req) => fulfillmentLabel(deps, sid(req), req.params.id, req.params.fulfillmentId),
  );

  // ── Refund calculator & invoice ────────────────────────────────────────────
  app.post(
    "/orders/:id/refunds/calculate",
    {
      onRequest: can("orders:refund"),
      schema: { tags, operationId: "calculateRefund", params: idParams, body: refundInput.omit({ amount: true, notify: true, reason: true }), response: { 200: refundCalculationSchema, ...errorResponses } },
    },
    (req) => calculateRefund(deps.db, sid(req), req.params.id, req.body),
  );
  app.get("/orders/:id/invoice.pdf", { onRequest: can("orders:read"), schema: { tags, operationId: "orderInvoicePdf", params: idParams, produces: ["application/pdf"] } }, async (req, reply) => {
    const inv = await getInvoice(deps, sid(req), req.params.id);
    return reply
      .header("content-type", "application/pdf")
      .header("content-disposition", `inline; filename="invoice-${inv.number.replace(/[^A-Za-z0-9-]/g, "_")}.pdf"`)
      .header("cache-control", "private, no-store")
      .send(renderInvoicePdf(inv));
  });

  // ── Returns ────────────────────────────────────────────────────────────────
  app.get(
    "/returns",
    { onRequest: can("orders:read"), schema: { tags, operationId: "listReturns", querystring: z.object({ status: returnStatus.optional() }), response: { 200: returnListSchema, ...errorResponses } } },
    async (req) => ({ items: await listAllReturns(deps.db, sid(req), req.query.status) }),
  );
  app.post(
    "/orders/:id/returns",
    { onRequest: can("orders:returns"), schema: { tags, operationId: "createReturn", params: idParams, body: returnRequestInput, response: { 200: orderAdminSchema, ...errorResponses } } },
    async (req) => {
      await requestReturn(deps, { type: "staff", actor: actorOf(req) }, sid(req), req.params.id, req.body);
      return order(req, req.params.id);
    },
  );
  /** Runs a return transition, then answers with the return's order. */
  async function afterReturn(req: { staff?: { storeId: string } }, returnId: string, run: () => Promise<unknown>) {
    await run();
    const [r] = await deps.db.select({ orderId: returns.orderId }).from(returns).where(and(eq(returns.storeId, sid(req)), eq(returns.id, returnId)));
    if (!r) throw new AppError("not_found", "Return not found");
    return order(req, r.orderId);
  }
  const returnRoute = (operationId: string) => ({ onRequest: can("orders:returns"), schema: { tags, operationId, params: idParams, response: { 200: orderAdminSchema, ...errorResponses } } });
  app.post("/returns/:id/approve", { ...returnRoute("approveReturn"), schema: { ...returnRoute("approveReturn").schema, body: z.object({ notify: z.boolean().default(true) }) } }, (req) =>
    afterReturn(req, req.params.id, () => approveReturn(deps, actorOf(req), sid(req), req.params.id, req.body)),
  );
  app.post("/returns/:id/decline", { ...returnRoute("declineReturn"), schema: { ...returnRoute("declineReturn").schema, body: declineReturnInput } }, (req) =>
    afterReturn(req, req.params.id, () => declineReturn(deps, actorOf(req), sid(req), req.params.id, req.body)),
  );
  app.post("/returns/:id/receive", { ...returnRoute("receiveReturn"), schema: { ...returnRoute("receiveReturn").schema, body: receiveReturnInput } }, (req) =>
    afterReturn(req, req.params.id, () => receiveReturn(deps, actorOf(req), sid(req), req.params.id, req.body)),
  );
  app.post("/returns/:id/resolve", { ...returnRoute("resolveReturn"), schema: { ...returnRoute("resolveReturn").schema, body: resolveReturnInput } }, (req) =>
    afterReturn(req, req.params.id, () => resolveReturn(deps, actorOf(req), sid(req), req.params.id, req.body)),
  );
  app.post("/returns/:id/cancel", returnRoute("cancelReturn"), (req) => afterReturn(req, req.params.id, () => cancelReturn(deps, actorOf(req), sid(req), req.params.id)));

  // ── Shipping zones & rates ─────────────────────────────────────────────────
  const shippingRead = can("settings:read");
  const shippingWrite = can("settings:shipping");
  const shippingView = (req: { staff?: { storeId: string } }) => listShipping(deps.db, sid(req));
  app.get("/shipping", { onRequest: shippingRead, schema: { tags, operationId: "getShipping", response: { 200: shippingSettingsSchema, ...errorResponses } } }, (req) => shippingView(req));
  app.post("/shipping/zones", { onRequest: shippingWrite, schema: { tags, operationId: "createShippingZone", body: zoneInput, response: { 200: shippingSettingsSchema, ...errorResponses } } }, async (req) => {
    await saveZone(deps, actorOf(req), sid(req), req.body);
    return shippingView(req);
  });
  app.put(
    "/shipping/zones/:id",
    { onRequest: shippingWrite, schema: { tags, operationId: "updateShippingZone", params: idParams, body: zoneInput, response: { 200: shippingSettingsSchema, ...errorResponses } } },
    async (req) => {
      await saveZone(deps, actorOf(req), sid(req), req.body, req.params.id);
      return shippingView(req);
    },
  );
  app.delete("/shipping/zones/:id", { onRequest: shippingWrite, schema: { tags, operationId: "deleteShippingZone", params: idParams, response: { 200: shippingSettingsSchema, ...errorResponses } } }, async (req) => {
    await deleteZone(deps, actorOf(req), sid(req), req.params.id);
    return shippingView(req);
  });
  app.post("/shipping/rates", { onRequest: shippingWrite, schema: { tags, operationId: "createShippingRate", body: rateInput, response: { 200: shippingSettingsSchema, ...errorResponses } } }, async (req) => {
    await saveRate(deps, actorOf(req), sid(req), req.body);
    return shippingView(req);
  });
  app.put(
    "/shipping/rates/:id",
    { onRequest: shippingWrite, schema: { tags, operationId: "updateShippingRate", params: idParams, body: rateInput, response: { 200: shippingSettingsSchema, ...errorResponses } } },
    async (req) => {
      await saveRate(deps, actorOf(req), sid(req), req.body, req.params.id);
      return shippingView(req);
    },
  );
  app.delete("/shipping/rates/:id", { onRequest: shippingWrite, schema: { tags, operationId: "deleteShippingRate", params: idParams, response: { 200: shippingSettingsSchema, ...errorResponses } } }, async (req) => {
    await deleteRate(deps, actorOf(req), sid(req), req.params.id);
    return shippingView(req);
  });

  // ── Tax rates & overrides ──────────────────────────────────────────────────
  const taxWrite = can("settings:tax");
  const taxView = (req: { staff?: { storeId: string } }) => listTax(deps.db, sid(req));
  app.get("/tax", { onRequest: can("settings:read"), schema: { tags, operationId: "getTax", response: { 200: taxSettingsSchema, ...errorResponses } } }, (req) => taxView(req));
  app.post("/tax/rates", { onRequest: taxWrite, schema: { tags, operationId: "createTaxRate", body: taxRateInput, response: { 200: taxSettingsSchema, ...errorResponses } } }, async (req) => {
    await saveTaxRate(deps, actorOf(req), sid(req), req.body);
    return taxView(req);
  });
  app.put("/tax/rates/:id", { onRequest: taxWrite, schema: { tags, operationId: "updateTaxRate", params: idParams, body: taxRateInput, response: { 200: taxSettingsSchema, ...errorResponses } } }, async (req) => {
    await saveTaxRate(deps, actorOf(req), sid(req), req.body, req.params.id);
    return taxView(req);
  });
  app.delete("/tax/rates/:id", { onRequest: taxWrite, schema: { tags, operationId: "deleteTaxRate", params: idParams, response: { 200: taxSettingsSchema, ...errorResponses } } }, async (req) => {
    await deleteTaxRate(deps, actorOf(req), sid(req), req.params.id);
    return taxView(req);
  });
  app.post("/tax/overrides", { onRequest: taxWrite, schema: { tags, operationId: "createTaxOverride", body: taxOverrideInput, response: { 200: taxSettingsSchema, ...errorResponses } } }, async (req) => {
    await saveTaxOverride(deps, actorOf(req), sid(req), req.body);
    return taxView(req);
  });
  app.put(
    "/tax/overrides/:id",
    { onRequest: taxWrite, schema: { tags, operationId: "updateTaxOverride", params: idParams, body: taxOverrideInput, response: { 200: taxSettingsSchema, ...errorResponses } } },
    async (req) => {
      await saveTaxOverride(deps, actorOf(req), sid(req), req.body, req.params.id);
      return taxView(req);
    },
  );
  app.delete("/tax/overrides/:id", { onRequest: taxWrite, schema: { tags, operationId: "deleteTaxOverride", params: idParams, response: { 200: taxSettingsSchema, ...errorResponses } } }, async (req) => {
    await deleteTaxOverride(deps, actorOf(req), sid(req), req.params.id);
    return taxView(req);
  });

  // ── Gift cards ─────────────────────────────────────────────────────────────
  app.get(
    "/gift-cards",
    {
      onRequest: can("gift_cards:read"),
      schema: { tags, operationId: "listGiftCards", querystring: z.object({ query: z.string().max(40).optional() }), response: { 200: z.object({ items: z.array(giftCardSchema) }), ...errorResponses } },
    },
    async (req) => ({ items: await listGiftCards(deps.db, sid(req), req.query.query ? { query: req.query.query } : {}) }),
  );
  app.post("/gift-cards", { onRequest: can("gift_cards:write"), schema: { tags, operationId: "issueGiftCard", body: issueGiftCardInput, response: { 200: giftCardIssuedSchema, ...errorResponses } } }, (req) =>
    issueGiftCard(deps, actorOf(req), sid(req), req.body),
  );
  app.get("/gift-cards/:id", { onRequest: can("gift_cards:read"), schema: { tags, operationId: "getGiftCard", params: idParams, response: { 200: giftCardDetailSchema, ...errorResponses } } }, (req) =>
    getGiftCard(deps.db, sid(req), req.params.id),
  );
  app.patch(
    "/gift-cards/:id",
    { onRequest: can("gift_cards:write"), schema: { tags, operationId: "updateGiftCard", params: idParams, body: updateGiftCardInput, response: { 200: giftCardDetailSchema, ...errorResponses } } },
    async (req) => {
      await updateGiftCard(deps, actorOf(req), sid(req), req.params.id, req.body);
      return getGiftCard(deps.db, sid(req), req.params.id);
    },
  );

  // ── Dashboard & reports ────────────────────────────────────────────────────
  app.get("/dashboard", { onRequest: can("home:read"), schema: { tags, operationId: "getDashboard", response: { 200: dashboardSchema, ...errorResponses } } }, (req) =>
    dashboardCards(deps.db, sid(req), new Date()),
  );
  app.get("/reports/sales", { onRequest: can("reports:read"), schema: { tags, operationId: "salesReport", querystring: reportQuery, response: { 200: salesReportSchema, ...errorResponses } } }, (req) =>
    salesReport(deps.db, sid(req), req.query),
  );
  app.get("/reports/export", { onRequest: can("reports:read"), schema: { tags, operationId: "exportReport", querystring: reportExportQuery, produces: ["text/csv"] } }, async (req, reply) => {
    const { filename, csv } = await reportCsv(deps.db, sid(req), req.query);
    return reply.header("content-type", "text/csv; charset=utf-8").header("content-disposition", `attachment; filename="${filename}"`).header("cache-control", "private, no-store").send(csv);
  });

  // ── Staff, roles, invitations, 2FA policy, audit log ──────────────────────
  const staffAdmin = can("settings:staff");
  app.get("/permissions", { onRequest: can("settings:read"), schema: { tags, operationId: "listPermissionGroups", response: { 200: permissionGroupsSchema, ...errorResponses } } }, () =>
    PERMISSION_GROUPS.map((g) => ({ label: g.label, permissions: [...g.permissions] })),
  );
  app.get("/roles", { onRequest: can("settings:read"), schema: { tags, operationId: "listRoles", response: { 200: z.object({ items: z.array(roleSchema) }), ...errorResponses } } }, async (req) => ({
    items: await listRoles(deps.db, sid(req)),
  }));
  app.post("/roles", { onRequest: staffAdmin, schema: { tags, operationId: "createRole", body: roleInput, response: { 200: z.object({ items: z.array(roleSchema) }), ...errorResponses } } }, async (req) => {
    await saveRole(deps, actorOf(req), sid(req), req.body);
    return { items: await listRoles(deps.db, sid(req)) };
  });
  app.put(
    "/roles/:id",
    { onRequest: staffAdmin, schema: { tags, operationId: "updateRole", params: idParams, body: roleInput, response: { 200: z.object({ items: z.array(roleSchema) }), ...errorResponses } } },
    async (req) => {
      await saveRole(deps, actorOf(req), sid(req), req.body, req.params.id);
      return { items: await listRoles(deps.db, sid(req)) };
    },
  );
  app.delete("/roles/:id", { onRequest: staffAdmin, schema: { tags, operationId: "deleteRole", params: idParams, response: { 200: z.object({ items: z.array(roleSchema) }), ...errorResponses } } }, async (req) => {
    await deleteRole(deps, actorOf(req), sid(req), req.params.id);
    return { items: await listRoles(deps.db, sid(req)) };
  });
  app.get("/team", { onRequest: can("settings:read"), schema: { tags, operationId: "listTeam", response: { 200: z.object({ items: z.array(teamMemberSchema) }), ...errorResponses } } }, async (req) => ({
    items: await listTeam(deps.db, sid(req)),
  }));
  app.patch(
    "/team/:id",
    { onRequest: staffAdmin, schema: { tags, operationId: "updateTeamMember", params: idParams, body: staffUpdateInput, response: { 200: z.object({ items: z.array(teamMemberSchema) }), ...errorResponses } } },
    async (req) => {
      await updateStaffMember(deps, actorOf(req), sid(req), req.params.id, req.body);
      return { items: await listTeam(deps.db, sid(req)) };
    },
  );
  app.get("/invites", { onRequest: can("settings:read"), schema: { tags, operationId: "listInvites", response: { 200: z.object({ items: z.array(inviteSchema) }), ...errorResponses } } }, async (req) => ({
    items: await listInvites(deps.db, sid(req)),
  }));
  app.post(
    "/invites",
    {
      onRequest: staffAdmin,
      config: { rateLimit: { max: 20, timeWindow: "1 hour" } },
      schema: { tags, operationId: "inviteStaff", body: inviteInput, response: { 200: z.object({ items: z.array(inviteSchema) }), ...errorResponses } },
    },
    async (req) => {
      await inviteStaff(deps, actorOf(req), sid(req), req.body);
      return { items: await listInvites(deps.db, sid(req)) };
    },
  );
  app.delete("/invites/:id", { onRequest: staffAdmin, schema: { tags, operationId: "revokeInvite", params: idParams, response: { 200: z.object({ items: z.array(inviteSchema) }), ...errorResponses } } }, async (req) => {
    await revokeInvite(deps, actorOf(req), sid(req), req.params.id);
    return { items: await listInvites(deps.db, sid(req)) };
  });
  app.put("/security", { onRequest: can("settings:security"), schema: { tags, operationId: "updateSecurity", body: securityInput, response: { 200: okBody, ...errorResponses } } }, async (req) => {
    await updateSecurity(deps, actorOf(req), sid(req), req.body);
    return ok;
  });
  app.get("/audit", { onRequest: can("audit:read"), schema: { tags, operationId: "searchAuditLog", querystring: auditQuery, response: { 200: auditPageSchema, ...errorResponses } } }, (req) =>
    searchAudit(deps.db, sid(req), req.query),
  );
};

/** Public invitation endpoints (`/api/admin/auth/invites/:token`). */
export const inviteRoutes: FastifyPluginAsyncZod<{ deps: AppDeps }> = async (app, { deps }) => {
  const tokenParams = z.object({ token: z.string().min(20).max(200) });
  const limit = { rateLimit: { max: 20, timeWindow: "1 minute" } };
  app.get("/invites/:token", { config: limit, schema: { tags: ["auth"], operationId: "describeInvite", params: tokenParams, response: { 200: inviteInfoSchema, ...errorResponses } } }, (req) =>
    describeInvite(deps, req.params.token),
  );
  app.post(
    "/invites/:token/accept",
    {
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
      schema: { tags: ["auth"], operationId: "acceptInvite", params: tokenParams, body: acceptInviteInput, response: { 200: z.object({ email: z.string() }), ...errorResponses } },
    },
    async (req) => {
      const { email } = await acceptInvite(deps, req.params.token, req.body, { ip: req.ip, userAgent: req.headers["user-agent"] ?? null });
      return { email };
    },
  );
};
