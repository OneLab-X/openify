import {
  addOrderComment,
  addressInput,
  adminCustomerInput,
  AppError,
  cancelInput,
  cancelOrder,
  commentInput,
  completeDraft,
  completeDraftInput,
  customerListQuery,
  deleteCustomerAddress,
  deleteDiscount,
  deleteDraft,
  discountInput,
  draftInput,
  getCustomerAdmin,
  getDiscount,
  getDraft,
  getOrderAdmin,
  listCustomers,
  listDiscounts,
  listDrafts,
  listOrders,
  markOrderPaid,
  markPaidInput,
  notificationSettings,
  orderListQuery,
  orderMetaInput,
  refundInput,
  refundOrder,
  saveCustomerAddress,
  saveCustomerAdmin,
  saveDiscount,
  saveDraft,
  searchVariants,
  sendShippingUpdate,
  shippingUpdateInput,
  templateUpdateInput,
  updateNotificationTemplate,
  updateOrderMeta,
  hasPermission,
} from "@shopkit/core";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import type { AppDeps } from "../deps.js";
import { actorOf, requireStaff } from "../plugins/auth.js";
import { errorResponses, okBody } from "../schemas.js";
import {
  customerAdminSchema,
  customerListSchema,
  discountSchema,
  draftListSchema,
  draftSchema,
  notificationTemplateSchema,
  orderAdminSchema,
  orderListSchema,
} from "../schemas-commerce.js";

const tags = ["admin"];
const idParams = z.object({ id: z.uuid() });
const ok = { ok: true as const };

/** Admin orders, draft orders, customers, discounts and notification templates. */
export const commerceRoutes: FastifyPluginAsyncZod<{ deps: AppDeps }> = async (app, { deps }) => {
  const sid = (req: { staff?: { storeId: string } }) => req.staff!.storeId;
  const ordersRead = requireStaff(deps, "orders:read");
  const ordersWrite = requireStaff(deps, "orders:write");
  const ordersRefund = requireStaff(deps, "orders:refund");
  const customersRead = requireStaff(deps, "customers:read");
  const customersWrite = requireStaff(deps, "customers:write");

  // ── Orders ─────────────────────────────────────────────────────────────────
  app.get("/orders", { onRequest: ordersRead, schema: { tags, operationId: "listOrders", querystring: orderListQuery, response: { 200: orderListSchema, ...errorResponses } } }, (req) =>
    listOrders(deps, sid(req), req.query),
  );
  app.get("/orders/:id", { onRequest: ordersRead, schema: { tags, operationId: "getOrder", params: idParams, response: { 200: orderAdminSchema, ...errorResponses } } }, (req) =>
    getOrderAdmin(deps, sid(req), req.params.id),
  );
  app.patch(
    "/orders/:id",
    { onRequest: ordersWrite, schema: { tags, operationId: "updateOrder", params: idParams, body: orderMetaInput, response: { 200: orderAdminSchema, ...errorResponses } } },
    async (req) => {
      await updateOrderMeta(deps, actorOf(req), sid(req), req.params.id, req.body);
      return getOrderAdmin(deps, sid(req), req.params.id);
    },
  );
  app.post(
    "/orders/:id/comments",
    { onRequest: ordersWrite, schema: { tags, operationId: "addOrderComment", params: idParams, body: commentInput, response: { 200: orderAdminSchema, ...errorResponses } } },
    async (req) => {
      await addOrderComment(deps, actorOf(req), sid(req), req.params.id, req.body);
      return getOrderAdmin(deps, sid(req), req.params.id);
    },
  );
  app.post(
    "/orders/:id/mark-paid",
    { onRequest: ordersWrite, schema: { tags, operationId: "markOrderPaid", params: idParams, body: markPaidInput, response: { 200: orderAdminSchema, ...errorResponses } } },
    async (req) => {
      await markOrderPaid(deps, actorOf(req), sid(req), req.params.id, req.body);
      return getOrderAdmin(deps, sid(req), req.params.id);
    },
  );
  app.post(
    "/orders/:id/refunds",
    { onRequest: ordersRefund, schema: { tags, operationId: "refundOrder", params: idParams, body: refundInput, response: { 200: orderAdminSchema, ...errorResponses } } },
    async (req) => {
      await refundOrder(deps, actorOf(req), sid(req), req.params.id, req.body);
      return getOrderAdmin(deps, sid(req), req.params.id);
    },
  );
  app.post(
    "/orders/:id/cancel",
    { onRequest: ordersWrite, schema: { tags, operationId: "cancelOrder", params: idParams, body: cancelInput, response: { 200: orderAdminSchema, ...errorResponses } } },
    async (req) => {
      if (req.body.refund !== false && !hasPermission(req.staff!.permissions, "orders:refund")) {
        throw new AppError("forbidden", "Refunding needs the orders:refund permission; cancel without a refund instead");
      }
      await cancelOrder(deps, actorOf(req), sid(req), req.params.id, req.body);
      return getOrderAdmin(deps, sid(req), req.params.id);
    },
  );
  app.post(
    "/orders/:id/shipping-update",
    { onRequest: ordersWrite, schema: { tags, operationId: "sendShippingUpdate", params: idParams, body: shippingUpdateInput, response: { 200: orderAdminSchema, ...errorResponses } } },
    async (req) => {
      await sendShippingUpdate(deps, actorOf(req), sid(req), req.params.id, req.body);
      return getOrderAdmin(deps, sid(req), req.params.id);
    },
  );

  // ── Draft orders ───────────────────────────────────────────────────────────
  app.get("/draft-orders", { onRequest: ordersRead, schema: { tags, operationId: "listDraftOrders", response: { 200: draftListSchema, ...errorResponses } } }, async (req) => ({
    items: await listDrafts(deps, sid(req)),
  }));
  app.post("/draft-orders", { onRequest: ordersWrite, schema: { tags, operationId: "createDraftOrder", body: draftInput, response: { 200: draftSchema, ...errorResponses } } }, (req) =>
    saveDraft(deps, actorOf(req), sid(req), req.body),
  );
  app.get("/draft-orders/:id", { onRequest: ordersRead, schema: { tags, operationId: "getDraftOrder", params: idParams, response: { 200: draftSchema, ...errorResponses } } }, (req) =>
    getDraft(deps, sid(req), req.params.id),
  );
  app.put(
    "/draft-orders/:id",
    { onRequest: ordersWrite, schema: { tags, operationId: "updateDraftOrder", params: idParams, body: draftInput, response: { 200: draftSchema, ...errorResponses } } },
    (req) => saveDraft(deps, actorOf(req), sid(req), req.body, req.params.id),
  );
  app.delete("/draft-orders/:id", { onRequest: ordersWrite, schema: { tags, operationId: "deleteDraftOrder", params: idParams, response: { 200: okBody, ...errorResponses } } }, async (req) => {
    await deleteDraft(deps, actorOf(req), sid(req), req.params.id);
    return ok;
  });
  app.post(
    "/draft-orders/:id/complete",
    {
      onRequest: ordersWrite,
      schema: { tags, operationId: "completeDraftOrder", params: idParams, body: completeDraftInput, response: { 200: z.object({ orderId: z.uuid() }), ...errorResponses } },
    },
    (req) => completeDraft(deps, actorOf(req), sid(req), req.params.id, req.body),
  );
  app.get(
    "/variants/search",
    {
      onRequest: ordersRead,
      schema: {
        tags,
        operationId: "searchVariants",
        querystring: z.object({ q: z.string().max(200).default("") }),
        response: {
          200: z.object({
            items: z.array(
              z.object({
                variantId: z.uuid(),
                productId: z.uuid(),
                productTitle: z.string(),
                variantTitle: z.string().nullable(),
                sku: z.string().nullable(),
                price: z.number().int(),
                currency: z.string(),
                available: z.number().int().nullable(),
                inventoryPolicy: z.enum(["deny", "continue"]),
              }),
            ),
          }),
          ...errorResponses,
        },
      },
    },
    async (req) => ({ items: await searchVariants(deps, sid(req), req.query.q) }),
  );

  // ── Customers ──────────────────────────────────────────────────────────────
  app.get("/customers", { onRequest: customersRead, schema: { tags, operationId: "listCustomers", querystring: customerListQuery, response: { 200: customerListSchema, ...errorResponses } } }, (req) =>
    listCustomers(deps.db, sid(req), req.query),
  );
  app.post("/customers", { onRequest: customersWrite, schema: { tags, operationId: "createCustomer", body: adminCustomerInput, response: { 200: customerAdminSchema, ...errorResponses } } }, async (req) => {
    const c = await saveCustomerAdmin(deps, actorOf(req), sid(req), req.body);
    return getCustomerAdmin(deps.db, sid(req), c.id);
  });
  app.get("/customers/:id", { onRequest: customersRead, schema: { tags, operationId: "getCustomer", params: idParams, response: { 200: customerAdminSchema, ...errorResponses } } }, (req) =>
    getCustomerAdmin(deps.db, sid(req), req.params.id),
  );
  app.put(
    "/customers/:id",
    { onRequest: customersWrite, schema: { tags, operationId: "updateCustomer", params: idParams, body: adminCustomerInput, response: { 200: customerAdminSchema, ...errorResponses } } },
    async (req) => {
      await saveCustomerAdmin(deps, actorOf(req), sid(req), req.body, req.params.id);
      return getCustomerAdmin(deps.db, sid(req), req.params.id);
    },
  );
  app.post(
    "/customers/:id/addresses",
    { onRequest: customersWrite, schema: { tags, operationId: "addCustomerAddress", params: idParams, body: addressInput, response: { 200: customerAdminSchema, ...errorResponses } } },
    async (req) => {
      await saveCustomerAddress(deps, sid(req), req.params.id, req.body);
      return getCustomerAdmin(deps.db, sid(req), req.params.id);
    },
  );
  app.delete(
    "/customers/:id/addresses/:addressId",
    {
      onRequest: customersWrite,
      schema: { tags, operationId: "deleteCustomerAddress", params: z.object({ id: z.uuid(), addressId: z.uuid() }), response: { 200: customerAdminSchema, ...errorResponses } },
    },
    async (req) => {
      await deleteCustomerAddress(deps, sid(req), req.params.id, req.params.addressId);
      return getCustomerAdmin(deps.db, sid(req), req.params.id);
    },
  );

  // ── Discounts (basic codes) ────────────────────────────────────────────────
  app.get("/discounts", { onRequest: ordersRead, schema: { tags, operationId: "listDiscounts", response: { 200: z.object({ items: z.array(discountSchema) }), ...errorResponses } } }, async (req) => ({
    items: await listDiscounts(deps.db, sid(req)),
  }));
  app.post("/discounts", { onRequest: ordersWrite, schema: { tags, operationId: "createDiscount", body: discountInput, response: { 200: discountSchema, ...errorResponses } } }, (req) =>
    saveDiscount(deps, actorOf(req), sid(req), req.body),
  );
  app.get("/discounts/:id", { onRequest: ordersRead, schema: { tags, operationId: "getDiscount", params: idParams, response: { 200: discountSchema, ...errorResponses } } }, (req) =>
    getDiscount(deps.db, sid(req), req.params.id),
  );
  app.put("/discounts/:id", { onRequest: ordersWrite, schema: { tags, operationId: "updateDiscount", params: idParams, body: discountInput, response: { 200: discountSchema, ...errorResponses } } }, (req) =>
    saveDiscount(deps, actorOf(req), sid(req), req.body, req.params.id),
  );
  app.delete("/discounts/:id", { onRequest: ordersWrite, schema: { tags, operationId: "deleteDiscount", params: idParams, response: { 200: okBody, ...errorResponses } } }, async (req) => {
    await deleteDiscount(deps, actorOf(req), sid(req), req.params.id);
    return ok;
  });

  // ── Notification templates ─────────────────────────────────────────────────
  app.get(
    "/notifications/templates",
    { onRequest: requireStaff(deps, "settings:read"), schema: { tags, operationId: "listNotificationTemplates", response: { 200: z.object({ items: z.array(notificationTemplateSchema) }), ...errorResponses } } },
    async (req) => ({ items: await notificationSettings(deps, sid(req)) }),
  );
  app.put(
    "/notifications/templates/:id",
    {
      onRequest: requireStaff(deps, "settings:email"),
      schema: { tags, operationId: "updateNotificationTemplate", params: z.object({ id: z.string().max(60) }), body: templateUpdateInput, response: { 200: notificationTemplateSchema, ...errorResponses } },
    },
    (req) => updateNotificationTemplate(deps, sid(req), req.params.id, req.body),
  );
};
