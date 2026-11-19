import { z } from "zod";
import { mediaViewSchema } from "./schemas-catalog.js";

/** Response schemas for cart, checkout, orders, customers and discounts (OpenAPI components). */
const money = z.number().int();
const iso = z.string();

export const mailingAddressSchemaOut = z
  .object({
    firstName: z.string().nullish(),
    lastName: z.string().nullish(),
    company: z.string().nullish(),
    line1: z.string(),
    line2: z.string().nullish(),
    city: z.string(),
    province: z.string().nullish(),
    postalCode: z.string().nullish(),
    country: z.string(),
    phone: z.string().nullish(),
  })
  .meta({ id: "MailingAddress" });

const taxLine = z.object({ title: z.string(), rateBps: z.number(), amount: money }).meta({ id: "TaxLine" });

export const cartLineSchema = z
  .object({
    id: z.string(),
    variantId: z.uuid(),
    productId: z.uuid(),
    productHandle: z.string(),
    title: z.string(),
    variantTitle: z.string().nullable(),
    sku: z.string().nullable(),
    quantity: z.number().int(),
    unitPrice: money,
    compareAtPrice: money.nullable(),
    subtotal: money,
    discountAmount: money,
    attributes: z.record(z.string(), z.string()),
    image: mediaViewSchema.nullable(),
    availableQuantity: z.number().int().nullable(),
    stockIssue: z.string().nullable(),
  })
  .meta({ id: "CartLine" });

const discountState = z.object({ code: z.string().nullable(), applied: z.boolean(), error: z.string().nullable(), amount: money }).meta({ id: "DiscountState" });
const unavailableLine = z.object({ lineId: z.string().nullable(), variantId: z.string(), reason: z.string() });

export const cartSchema = z
  .object({
    id: z.string(),
    currency: z.string(),
    note: z.string().nullable(),
    attributes: z.record(z.string(), z.string()),
    lines: z.array(cartLineSchema),
    unavailable: z.array(unavailableLine),
    itemCount: z.number().int(),
    subtotal: money,
    discountTotal: money,
    taxTotal: money,
    total: money,
    taxesIncluded: z.boolean(),
    discount: discountState,
    discounts: z.array(z.object({ code: z.string().nullable(), title: z.string(), amount: money })),
    giftCards: z.array(z.object({ lastCharacters: z.string(), amount: money })),
    giftCardErrors: z.array(z.string()),
    giftCardTotal: money,
    totalDue: money,
    updatedAt: iso,
  })
  .meta({ id: "Cart" });

const shippingRate = z
  .object({ id: z.string(), title: z.string(), amount: money, kind: z.string(), description: z.string().nullish(), carrierRateId: z.string().nullish(), provider: z.string().nullish() })
  .meta({ id: "ShippingRate" });
const shippingLine = z.object({ id: z.string(), title: z.string(), amount: money, discount: money, kind: z.string().optional(), provider: z.string().nullish(), carrierRateId: z.string().nullish() });

export const checkoutSchema = z
  .object({
    id: z.uuid(),
    status: z.enum(["open", "completed"]),
    email: z.string().nullable(),
    phone: z.string().nullable(),
    marketingConsent: z.boolean(),
    shippingAddress: mailingAddressSchemaOut.nullable(),
    billingAddress: mailingAddressSchemaOut.nullable(),
    shippingRateId: z.string().nullable(),
    paymentProvider: z.string().nullable(),
    note: z.string().nullable(),
    currency: z.string(),
    lines: z.array(cartLineSchema),
    unavailable: z.array(unavailableLine),
    itemCount: z.number().int(),
    subtotal: money,
    discountTotal: money,
    shippingTotal: money,
    taxTotal: money,
    total: money,
    taxesIncluded: z.boolean(),
    taxLines: z.array(taxLine),
    discount: discountState,
    discounts: z.array(z.object({ code: z.string().nullable(), title: z.string(), amount: money })),
    giftCards: z.array(z.object({ lastCharacters: z.string(), amount: money })),
    giftCardErrors: z.array(z.string()),
    giftCardTotal: money,
    totalDue: money,
    buyerTaxId: z.string().nullable(),
    shippingRequired: z.boolean(),
    shippingRates: z.array(shippingRate),
    shippingLine: shippingLine.nullable(),
    paymentMethods: z.array(z.object({ id: z.string(), displayName: z.string(), flow: z.enum(["widget", "redirect", "offline"]) })),
    requirePhone: z.boolean(),
    missing: z.array(z.string()),
    blockers: z.array(z.string()),
    orderStatusToken: z.string().nullable(),
  })
  .meta({ id: "Checkout" });

export const paymentSessionSchema = z
  .object({
    orderId: z.uuid(),
    flow: z.enum(["widget", "redirect", "offline"]),
    provider: z.string(),
    clientPayload: z.record(z.string(), z.unknown()),
    redirectUrl: z.string().nullable(),
    orderStatusToken: z.string().nullable(),
  })
  .meta({ id: "PaymentSession" });

export const verifyResultSchema = z
  .object({ status: z.enum(["paid", "failed", "pending"]), message: z.string().nullable(), orderStatusToken: z.string().nullable() })
  .meta({ id: "PaymentVerifyResult" });

const orderLineSchema = z
  .object({
    id: z.uuid(),
    variantId: z.uuid().nullable(),
    productId: z.uuid().nullable(),
    productHandle: z.string().nullable(),
    title: z.string(),
    variantTitle: z.string().nullable(),
    sku: z.string().nullable(),
    hsnCode: z.string().nullable(),
    quantity: z.number().int(),
    unitPrice: money,
    compareAtPrice: money.nullable(),
    discountAmount: money,
    taxAmount: money,
    total: money,
    refundedQuantity: z.number().int(),
    restockedQuantity: z.number().int(),
    fulfilledQuantity: z.number().int(),
    returnedQuantity: z.number().int(),
    fulfillableQuantity: z.number().int(),
    giftCard: z.boolean(),
    locationId: z.uuid().nullable(),
    attributes: z.record(z.string(), z.string()),
    image: mediaViewSchema.nullable(),
  })
  .meta({ id: "OrderLine" });

export const fulfillmentSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    status: z.enum(["pending", "shipped", "in_transit", "out_for_delivery", "delivered", "failed", "cancelled"]),
    method: z.enum(["local_driver", "courier", "other_courier", "carrier", "pickup", "none"]),
    carrier: z.string().nullable(),
    carrierName: z.string(),
    trackingNumber: z.string().nullable(),
    trackingUrl: z.string().nullable(),
    driverName: z.string().nullable(),
    driverMobile: z.string().nullable(),
    tripLink: z.string().nullable(),
    provider: z.string().nullable(),
    labelUrl: z.string().nullable(),
    locationId: z.uuid().nullable(),
    notifyCustomer: z.boolean(),
    whatsappSentAt: iso.nullable(),
    deliveredAt: iso.nullable(),
    createdAt: iso,
    deliveryLines: z.array(z.string()),
    lines: z.array(z.object({ orderLineId: z.uuid(), quantity: z.number().int() })),
  })
  .meta({ id: "Fulfillment" });

export const returnSchema = z
  .object({
    id: z.uuid(),
    orderId: z.uuid(),
    name: z.string(),
    status: z.enum(["requested", "approved", "declined", "received", "closed", "cancelled"]),
    requestedBy: z.enum(["customer", "staff"]),
    customerNote: z.string().nullable(),
    staffNote: z.string().nullable(),
    declineReason: z.string().nullable(),
    resolution: z.enum(["refund", "exchange", "none"]).nullable(),
    refundId: z.uuid().nullable(),
    exchangeDraftId: z.uuid().nullable(),
    createdAt: iso,
    receivedAt: iso.nullable(),
    closedAt: iso.nullable(),
    lines: z.array(z.object({ id: z.uuid(), orderLineId: z.uuid(), quantity: z.number().int(), reason: z.string(), restock: z.boolean() })),
  })
  .meta({ id: "Return" });

const orderStatus = z.enum(["open", "closed", "cancelled"]);
const financialStatus = z.enum(["pending", "authorized", "paid", "partially_paid", "partially_refunded", "refunded", "voided"]);
const fulfillmentStatus = z.enum(["unfulfilled", "partially_fulfilled", "fulfilled", "returned"]);

const orderSummaryShape = {
  id: z.uuid(),
  name: z.string(),
  number: z.number().int().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  currency: z.string(),
  subtotal: money,
  discountTotal: money,
  shippingTotal: money,
  taxTotal: money,
  total: money,
  taxesIncluded: z.boolean(),
  amountPaid: money,
  amountRefunded: money,
  taxLines: z.array(taxLine),
  discountApplications: z.array(z.object({ code: z.string().nullable(), title: z.string(), kind: z.string(), amount: money })),
  shippingLine: z.object({ title: z.string(), amount: money, discount: money }).nullable(),
  shippingAddress: mailingAddressSchemaOut.nullable(),
  billingAddress: mailingAddressSchemaOut.nullable(),
  status: orderStatus,
  financialStatus,
  fulfillmentStatus,
  paymentProvider: z.string().nullable(),
  placedAt: iso.nullable(),
  cancelledAt: iso.nullable(),
  cancelReason: z.string().nullable(),
};

export const orderListSchema = z
  .object({
    items: z.array(z.object({ ...orderSummaryShape, customerName: z.string().nullable(), itemCount: z.number().int(), tags: z.array(z.string()) })),
    nextCursor: z.string().nullable(),
  })
  .meta({ id: "OrderList" });

export const orderAdminSchema = z
  .object({
    ...orderSummaryShape,
    note: z.string().nullable(),
    tags: z.array(z.string()),
    attributes: z.record(z.string(), z.string()),
    customerId: z.uuid().nullable(),
    paymentMode: z.enum(["test", "live"]).nullable(),
    sourceName: z.enum(["web", "admin", "draft"]),
    marketingConsent: z.boolean(),
    statusUrl: z.string(),
    giftCardTotal: money,
    buyerTaxId: z.string().nullable(),
    shipFrom: z.object({ name: z.string(), phone: z.string().nullish(), email: z.string().nullish(), line1: z.string(), line2: z.string().nullish(), city: z.string(), province: z.string().nullish(), postalCode: z.string(), country: z.string() }),
    lines: z.array(orderLineSchema),
    fulfillments: z.array(fulfillmentSchema),
    returns: z.array(returnSchema),
    transactions: z.array(
      z.object({
        id: z.uuid(),
        kind: z.enum(["authorization", "capture", "sale", "refund", "void"]),
        status: z.enum(["pending", "success", "failure"]),
        amount: money,
        currency: z.string(),
        provider: z.string(),
        mode: z.enum(["test", "live"]).nullable(),
        providerReference: z.string().nullable(),
        method: z.string().nullable(),
        errorMessage: z.string().nullable(),
        createdAt: iso,
      }),
    ),
    events: z.array(z.object({ id: z.uuid(), type: z.string(), message: z.string(), actorType: z.string(), actorId: z.string().nullable(), createdAt: iso })),
    refunds: z.array(
      z.object({ id: z.uuid(), amount: money, shippingAmount: money, status: z.enum(["pending", "success", "failure"]), currency: z.string(), reason: z.string().nullable(), restock: z.boolean(), returnId: z.uuid().nullable(), createdAt: iso }),
    ),
  })
  .meta({ id: "OrderAdmin" });

export const orderPublicSchema = z
  .object({
    ...orderSummaryShape,
    placed: z.boolean(),
    lines: z.array(orderLineSchema),
    shippingUpdates: z.array(
      z.object({ at: iso, carrier: z.string().nullable(), trackingNumber: z.string().nullable(), trackingUrl: z.string().nullable(), message: z.string().nullable() }),
    ),
    timeline: z.array(z.object({ type: z.string(), at: iso })),
    fulfillments: z.array(
      z.object({ name: z.string(), status: z.string(), carrierName: z.string(), trackingNumber: z.string().nullable(), trackingUrl: z.string().nullable(), deliveredAt: iso.nullable(), createdAt: iso }),
    ),
    returnable: z.record(z.string(), z.number().int()),
    returns: z.array(z.object({ id: z.uuid(), name: z.string(), status: z.string(), createdAt: iso, lines: z.array(z.object({ orderLineId: z.uuid(), quantity: z.number().int() })) })),
    paymentInstructions: z.object({ title: z.string(), details: z.string(), instructions: z.string().nullable() }).nullable(),
  })
  .meta({ id: "OrderPublic" });

export const customerAddressSchema = mailingAddressSchemaOut.extend({ id: z.uuid(), isDefault: z.boolean() }).meta({ id: "CustomerAddress" });

export const customerSchema = z
  .object({
    id: z.uuid(),
    email: z.string(),
    firstName: z.string().nullable(),
    lastName: z.string().nullable(),
    phone: z.string().nullable(),
    state: z.enum(["enabled", "disabled"]),
    marketingConsent: z.boolean(),
    hasPassword: z.boolean(),
    note: z.string().nullable(),
    taxId: z.string().nullable(),
    tags: z.array(z.string()),
    ordersCount: z.number().int(),
    totalSpent: money,
    currency: z.string().nullable(),
    lastOrderAt: iso.nullable(),
    createdAt: iso,
    addresses: z.array(customerAddressSchema),
  })
  .meta({ id: "Customer" });

const customerOrderRow = z.object({
  id: z.uuid(),
  name: z.string(),
  placedAt: iso,
  total: money,
  currency: z.string(),
  financialStatus,
  fulfillmentStatus,
  status: orderStatus,
});

export const customerAdminSchema = customerSchema.extend({ orders: z.array(customerOrderRow) }).meta({ id: "CustomerAdmin" });

export const customerListSchema = z
  .object({
    items: z.array(
      z.object({
        id: z.uuid(),
        email: z.string(),
        name: z.string().nullable(),
        phone: z.string().nullable(),
        state: z.enum(["enabled", "disabled"]),
        marketingConsent: z.boolean(),
        ordersCount: z.number().int(),
        totalSpent: money,
        currency: z.string().nullable(),
        lastOrderAt: iso.nullable(),
        createdAt: iso,
      }),
    ),
    nextCursor: z.string().nullable(),
  })
  .meta({ id: "CustomerList" });

export const accountOrdersSchema = z.object({ items: z.array(customerOrderRow) }).meta({ id: "AccountOrders" });

const targetOut = z.enum(["all", "collections", "products"]);
export const discountSchema = z
  .object({
    id: z.uuid(),
    title: z.string(),
    method: z.enum(["code", "automatic"]),
    code: z.string().nullable(),
    kind: z.enum(["percentage", "fixed_amount", "free_shipping", "buy_x_get_y"]),
    value: z.number().int(),
    target: targetOut,
    productIds: z.array(z.uuid()),
    collectionIds: z.array(z.uuid()),
    perItem: z.boolean(),
    bxgy: z
      .object({
        buy: z.object({ quantity: z.number().int(), target: targetOut, productIds: z.array(z.uuid()), collectionIds: z.array(z.uuid()) }),
        get: z.object({ quantity: z.number().int(), target: targetOut, productIds: z.array(z.uuid()), collectionIds: z.array(z.uuid()), percentOff: z.number().int() }),
        usesPerOrder: z.number().int().nullable(),
      })
      .nullable(),
    minSubtotal: money.nullable(),
    minQuantity: z.number().int().nullable(),
    maxShippingAmount: money.nullable(),
    eligibility: z.enum(["all", "customers", "tags"]),
    customerIds: z.array(z.uuid()),
    customerTags: z.array(z.string()),
    startsAt: iso.nullable(),
    endsAt: iso.nullable(),
    usageLimit: z.number().int().nullable(),
    usageLimitPerCustomer: z.number().int().nullable(),
    oncePerCustomer: z.boolean(),
    combinesWith: z.object({ product: z.boolean(), order: z.boolean(), shipping: z.boolean() }),
    status: z.enum(["active", "disabled"]),
    usageCount: z.number().int(),
    createdAt: iso,
  })
  .meta({ id: "Discount" });

export const draftSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    status: z.enum(["open", "completed"]),
    customerId: z.uuid().nullable(),
    email: z.string().nullable(),
    phone: z.string().nullable(),
    shippingAddress: mailingAddressSchemaOut.nullable(),
    shippingLine: z.object({ title: z.string(), amount: money }).nullable(),
    discount: z.object({ kind: z.enum(["percentage", "fixed_amount"]), value: z.number().int(), reason: z.string().optional() }).nullable(),
    note: z.string().nullable(),
    tags: z.array(z.string()),
    orderId: z.uuid().nullable(),
    orderName: z.string().nullable(),
    currency: z.string(),
    lines: z.array(cartLineSchema),
    unavailable: z.array(z.object({ variantId: z.string(), reason: z.string() })),
    subtotal: money,
    discountTotal: money,
    shippingTotal: money,
    taxTotal: money,
    total: money,
    taxesIncluded: z.boolean(),
    taxLines: z.array(taxLine),
    blockers: z.array(z.string()),
    createdAt: iso,
    updatedAt: iso,
  })
  .meta({ id: "DraftOrder" });

export const draftListSchema = z
  .object({
    items: z.array(z.object({ id: z.uuid(), name: z.string(), status: z.enum(["open", "completed"]), email: z.string().nullable(), total: money, currency: z.string(), itemCount: z.number().int(), createdAt: iso })),
  })
  .meta({ id: "DraftOrderList" });

export const notificationTemplateSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    audience: z.enum(["customer", "merchant"]),
    subject: z.string(),
    intro: z.string(),
    enabled: z.boolean(),
    defaultSubject: z.string(),
    defaultIntro: z.string(),
  })
  .meta({ id: "NotificationTemplate" });

export const accountSessionSchema = z.object({ customer: customerSchema }).meta({ id: "AccountSession" });
