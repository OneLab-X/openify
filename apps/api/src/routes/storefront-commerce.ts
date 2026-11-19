import {
  accountUpdateInput,
  addCartLines,
  addLinesInput,
  addressInput,
  AppError,
  cartView,
  checkoutUpdateInput,
  checkoutView,
  createPaymentSession,
  customerView,
  deleteCustomerAddress,
  destroyCustomerSession,
  emailInput,
  emptyCartView,
  findCart,
  getCustomer,
  getCustomerAdmin,
  getInstallStore,
  getOrCreateCart,
  getOrderPublic,
  getSetting,
  loadCheckout,
  loginCustomerWithPassword,
  mergeCartOnLogin,
  otpVerifyInput,
  passwordLoginInput,
  recoverCheckout,
  registerCustomer,
  registerInput,
  requestCustomerOtp,
  saveCustomerAddress,
  startCheckout,
  touchCustomerSession,
  updateAccount,
  updateCart,
  updateCartInput,
  updateCartLine,
  updateCheckout,
  updateLineInput,
  verifyCheckoutPayment,
  verifyCustomerOtp,
  verifyInput,
  verifyOrderStatusToken,
  type CustomerLogin,
} from "@shopkit/core";
import { orders, and, eq } from "@shopkit/db";
import type { FastifyReply, FastifyRequest, onRequestAsyncHookHandler } from "fastify";
import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import { z } from "zod";
import { secureCookies, type Config } from "../config.js";
import type { AppDeps } from "../deps.js";
import { errorResponses, okBody } from "../schemas.js";
import {
  accountOrdersSchema,
  accountSessionSchema,
  cartSchema,
  checkoutSchema,
  customerSchema,
  orderPublicSchema,
  paymentSessionSchema,
  verifyResultSchema,
} from "../schemas-commerce.js";

export const CART_COOKIE = "sk_cart";
export const CUSTOMER_COOKIE = "sk_customer";
const CART_MAX_AGE = 30 * 24 * 60 * 60;
const tags = ["storefront"];
const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Cart, checkout and customer-account endpoints. They are cookie-authenticated, so every mutating
 * request must carry `X-Shopkit-Client` (a custom header a cross-site form or <img> cannot send
 * without a CORS preflight, which this API never grants): CSRF protection without a token round trip.
 */
export const storefrontCommerceRoutes: FastifyPluginAsyncZod<{ deps: AppDeps; config: Config }> = async (app, { deps, config }) => {
  const secure = secureCookies(config);

  app.addHook("onRequest", async (req, reply) => {
    reply.header("cache-control", "no-store");
    if (!SAFE.has(req.method) && req.headers["x-shopkit-client"] !== "storefront") {
      throw new AppError("forbidden", "Missing X-Shopkit-Client header");
    }
  });

  async function storeId(): Promise<string> {
    const store = await getInstallStore(deps.db);
    if (!store || store.status !== "active") throw new AppError("setup_required", "This shop is not open yet");
    return store.id;
  }
  const setCart = (reply: FastifyReply, token: string) =>
    reply.setCookie(CART_COOKIE, token, { httpOnly: true, sameSite: "lax", secure, path: "/", maxAge: CART_MAX_AGE });
  const cartToken = (req: FastifyRequest) => req.cookies[CART_COOKIE];

  /** Signed-in customer (optional). A disabled account is treated as signed out. */
  async function currentCustomer(req: FastifyRequest, sid: string): Promise<{ id: string; email: string } | null> {
    const session = await touchCustomerSession(deps.redis, req.cookies[CUSTOMER_COOKIE]);
    if (!session || session.storeId !== sid) return null;
    const c = await getCustomer(deps.db, sid, session.customerId).catch(() => null);
    return c && c.state === "enabled" ? { id: c.id, email: c.email } : null;
  }
  const requireCustomer: onRequestAsyncHookHandler = async (req) => {
    const sid = await storeId();
    const c = await currentCustomer(req, sid);
    if (!c) throw new AppError("unauthorized", "Sign in to your account");
    req.customer = { ...c, storeId: sid };
  };

  async function viewOf(req: FastifyRequest, sid: string, cart: Awaited<ReturnType<typeof findCart>>) {
    const store = await getInstallStore(deps.db);
    if (!cart) return emptyCartView(store?.currency ?? "USD");
    const customer = await currentCustomer(req, sid);
    return cartView(deps, sid, cart, customer ?? undefined);
  }

  // ── Cart ──────────────────────────────────────────────────────────────────
  app.get("/cart", { schema: { tags, operationId: "getCart", response: { 200: cartSchema, ...errorResponses } } }, async (req) => {
    const sid = await storeId();
    return viewOf(req, sid, await findCart(deps.db, sid, cartToken(req)));
  });

  app.post(
    "/cart/lines",
    { schema: { tags, operationId: "addCartLines", body: addLinesInput, response: { 200: cartSchema, ...errorResponses } } },
    async (req, reply) => {
      const sid = await storeId();
      const customer = await currentCustomer(req, sid);
      const { cart, token, created } = await getOrCreateCart(deps, sid, cartToken(req), customer?.id);
      if (created) setCart(reply, token);
      await addCartLines(deps, sid, cart, req.body);
      return viewOf(req, sid, cart);
    },
  );

  app.patch(
    "/cart/lines/:lineId",
    { schema: { tags, operationId: "updateCartLine", params: z.object({ lineId: z.uuid() }), body: updateLineInput, response: { 200: cartSchema, ...errorResponses } } },
    async (req) => {
      const sid = await storeId();
      const cart = await findCart(deps.db, sid, cartToken(req));
      if (!cart) throw new AppError("not_found", "Cart not found");
      await updateCartLine(deps, sid, cart, req.params.lineId, req.body);
      return viewOf(req, sid, cart);
    },
  );

  app.delete(
    "/cart/lines/:lineId",
    { schema: { tags, operationId: "removeCartLine", params: z.object({ lineId: z.uuid() }), response: { 200: cartSchema, ...errorResponses } } },
    async (req) => {
      const sid = await storeId();
      const cart = await findCart(deps.db, sid, cartToken(req));
      if (!cart) throw new AppError("not_found", "Cart not found");
      await updateCartLine(deps, sid, cart, req.params.lineId, { quantity: 0 });
      return viewOf(req, sid, cart);
    },
  );

  app.patch("/cart", { schema: { tags, operationId: "updateCart", body: updateCartInput, response: { 200: cartSchema, ...errorResponses } } }, async (req, reply) => {
    const sid = await storeId();
    const { cart, token, created } = await getOrCreateCart(deps, sid, cartToken(req));
    if (created) setCart(reply, token);
    await updateCart(deps, cart, req.body);
    return viewOf(req, sid, (await findCart(deps.db, sid, token)));
  });

  // ── Checkout ──────────────────────────────────────────────────────────────
  app.post("/checkout", { schema: { tags, operationId: "startCheckout", response: { 200: z.object({ checkoutId: z.uuid() }), ...errorResponses } } }, async (req) => {
    const sid = await storeId();
    const cart = await findCart(deps.db, sid, cartToken(req));
    if (!cart) throw new AppError("validation_failed", "Your cart is empty");
    const customer = await currentCustomer(req, sid);
    const checkout = await startCheckout(deps, sid, cart, customer?.id);
    return { checkoutId: checkout.id };
  });

  const checkoutParams = z.object({ id: z.uuid() });
  const loaded = async (req: FastifyRequest<{ Params: { id: string } }>) => {
    const sid = await storeId();
    return { sid, ...(await loadCheckout(deps.db, sid, req.params.id, cartToken(req))) };
  };

  app.get("/checkouts/:id", { schema: { tags, operationId: "getCheckout", params: checkoutParams, response: { 200: checkoutSchema, ...errorResponses } } }, async (req) => {
    const { sid, checkout, cart } = await loaded(req);
    return checkoutView(deps, sid, checkout, cart);
  });

  app.patch(
    "/checkouts/:id",
    { schema: { tags, operationId: "updateCheckout", params: checkoutParams, body: checkoutUpdateInput, response: { 200: checkoutSchema, ...errorResponses } } },
    async (req) => {
      const { sid, checkout, cart } = await loaded(req);
      await updateCheckout(deps, sid, checkout, cart, req.body);
      const again = await loadCheckout(deps.db, sid, req.params.id, cartToken(req));
      return checkoutView(deps, sid, again.checkout, again.cart);
    },
  );

  // The browser never sends an amount: the server prices the checkout from the database.
  app.post(
    "/checkouts/:id/payment-session",
    {
      config: { rateLimit: { max: 20, timeWindow: "1 minute" } },
      schema: { tags, operationId: "createPaymentSession", params: checkoutParams, response: { 200: paymentSessionSchema, ...errorResponses } },
    },
    async (req) => createPaymentSession(deps, await storeId(), req.params.id, cartToken(req)),
  );

  app.post(
    "/checkouts/:id/verify",
    { schema: { tags, operationId: "verifyPayment", params: checkoutParams, body: verifyInput, response: { 200: verifyResultSchema, ...errorResponses } } },
    async (req) => verifyCheckoutPayment(deps, await storeId(), req.params.id, cartToken(req), req.body.payload),
  );

  /** Link from the abandoned-checkout email: restores the cart in this browser, then opens checkout. */
  app.get("/checkouts/recover/:token", { schema: { tags, operationId: "recoverCheckout", params: z.object({ token: z.string().max(200) }), hide: true } }, async (req, reply) => {
    const result = await recoverCheckout(deps, await storeId(), req.params.token);
    if (!result) return reply.redirect("/cart", 302);
    setCart(reply, result.cartToken);
    return reply.redirect(`/checkout?id=${result.checkoutId}`, 302);
  });

  // ── Order status (signed link, no login) ──────────────────────────────────
  app.get(
    "/orders/:token",
    { schema: { tags, operationId: "getOrderStatus", params: z.object({ token: z.string().max(200) }), response: { 200: orderPublicSchema, ...errorResponses } } },
    async (req) => {
      const id = verifyOrderStatusToken(deps, req.params.token);
      if (!id) throw new AppError("not_found", "Order not found");
      return getOrderPublic(deps, await storeId(), id);
    },
  );

  // ── Customer accounts ─────────────────────────────────────────────────────
  async function signIn(req: FastifyRequest, reply: FastifyReply, sid: string, login: CustomerLogin) {
    reply.setCookie(CUSTOMER_COOKIE, login.token, { httpOnly: true, sameSite: "lax", secure, path: "/", maxAge: 30 * 24 * 60 * 60 });
    const merged = await mergeCartOnLogin(deps, sid, cartToken(req), login.customer.id);
    if (merged.token && merged.token !== cartToken(req)) setCart(reply, merged.token);
    return { customer: login.customer };
  }
  const authLimit = { rateLimit: { max: 10, timeWindow: "1 minute" } };

  app.get(
    "/account/config",
    { schema: { tags, operationId: "getAccountConfig", response: { 200: z.object({ customerAuth: z.enum(["otp", "password"]) }), ...errorResponses } } },
    async () => ({ customerAuth: (await getSetting(deps.db, await storeId(), "checkout.config")).customerAuth }),
  );

  app.post("/account/otp", { config: authLimit, schema: { tags, operationId: "requestAccountOtp", body: emailInput, response: { 200: okBody, ...errorResponses } } }, async (req) => {
    await requestCustomerOtp(deps, await storeId(), req.body);
    return { ok: true as const };
  });

  app.post(
    "/account/otp/verify",
    { config: authLimit, schema: { tags, operationId: "verifyAccountOtp", body: otpVerifyInput, response: { 200: accountSessionSchema, ...errorResponses } } },
    async (req, reply) => {
      const sid = await storeId();
      return signIn(req, reply, sid, await verifyCustomerOtp(deps, sid, req.body));
    },
  );

  app.post(
    "/account/login",
    { config: authLimit, schema: { tags, operationId: "accountLogin", body: passwordLoginInput, response: { 200: accountSessionSchema, ...errorResponses } } },
    async (req, reply) => {
      const sid = await storeId();
      return signIn(req, reply, sid, await loginCustomerWithPassword(deps, sid, req.body));
    },
  );

  app.post(
    "/account/register",
    { config: authLimit, schema: { tags, operationId: "accountRegister", body: registerInput, response: { 200: accountSessionSchema, ...errorResponses } } },
    async (req, reply) => {
      const sid = await storeId();
      return signIn(req, reply, sid, await registerCustomer(deps, sid, req.body));
    },
  );

  app.post("/account/logout", { schema: { tags, operationId: "accountLogout", response: { 200: okBody } } }, async (req, reply) => {
    const token = req.cookies[CUSTOMER_COOKIE];
    if (token) await destroyCustomerSession(deps.redis, token);
    reply.clearCookie(CUSTOMER_COOKIE, { path: "/" });
    return { ok: true as const };
  });

  app.get("/account", { onRequest: requireCustomer, schema: { tags, operationId: "getAccount", response: { 200: customerSchema, ...errorResponses } } }, async (req) =>
    customerView(deps.db, await getCustomer(deps.db, req.customer!.storeId, req.customer!.id)),
  );

  app.patch(
    "/account",
    { onRequest: requireCustomer, schema: { tags, operationId: "updateAccount", body: accountUpdateInput, response: { 200: customerSchema, ...errorResponses } } },
    async (req) => updateAccount(deps, req.customer!.storeId, req.customer!.id, req.body),
  );

  app.post(
    "/account/addresses",
    { onRequest: requireCustomer, schema: { tags, operationId: "addAccountAddress", body: addressInput, response: { 200: customerSchema, ...errorResponses } } },
    async (req) => (await saveCustomerAddress(deps, req.customer!.storeId, req.customer!.id, req.body)).customer,
  );

  app.put(
    "/account/addresses/:id",
    {
      onRequest: requireCustomer,
      schema: { tags, operationId: "updateAccountAddress", params: z.object({ id: z.uuid() }), body: addressInput, response: { 200: customerSchema, ...errorResponses } },
    },
    async (req) => (await saveCustomerAddress(deps, req.customer!.storeId, req.customer!.id, req.body, req.params.id)).customer,
  );

  app.delete(
    "/account/addresses/:id",
    { onRequest: requireCustomer, schema: { tags, operationId: "deleteAccountAddress", params: z.object({ id: z.uuid() }), response: { 200: customerSchema, ...errorResponses } } },
    async (req) => deleteCustomerAddress(deps, req.customer!.storeId, req.customer!.id, req.params.id),
  );

  app.get("/account/orders", { onRequest: requireCustomer, schema: { tags, operationId: "listAccountOrders", response: { 200: accountOrdersSchema, ...errorResponses } } }, async (req) => ({
    items: (await getCustomerAdmin(deps.db, req.customer!.storeId, req.customer!.id)).orders,
  }));

  app.get(
    "/account/orders/:id",
    { onRequest: requireCustomer, schema: { tags, operationId: "getAccountOrder", params: z.object({ id: z.uuid() }), response: { 200: orderPublicSchema, ...errorResponses } } },
    async (req) => {
      const [own] = await deps.db
        .select({ id: orders.id })
        .from(orders)
        .where(and(eq(orders.storeId, req.customer!.storeId), eq(orders.id, req.params.id), eq(orders.customerId, req.customer!.id)));
      if (!own) throw new AppError("not_found", "Order not found");
      return getOrderPublic(deps, req.customer!.storeId, own.id);
    },
  );
};

declare module "fastify" {
  interface FastifyRequest {
    customer?: { id: string; email: string; storeId: string };
  }
}
