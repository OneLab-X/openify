import { z } from "zod";

/** Response schemas for Phase 4 operations: shipping, tax, gift cards, returns, reports, staff. */
const money = z.number().int();
const iso = z.string();

// ── Shipping ───────────────────────────────────────────────────────────────
const shippingRateAdmin = z
  .object({
    id: z.uuid(),
    zoneId: z.uuid().nullable(),
    name: z.string(),
    description: z.string().nullable(),
    kind: z.enum(["flat", "weight", "price", "carrier", "local_pickup", "local_delivery"]),
    amount: money,
    minValue: z.number().int().nullable(),
    maxValue: z.number().int().nullable(),
    freeOver: money.nullable(),
    postalPrefixes: z.array(z.string()),
    locationId: z.uuid().nullable(),
    provider: z.string().nullable(),
    active: z.boolean(),
    position: z.number().int(),
  })
  .meta({ id: "ShippingRateAdmin" });

export const shippingSettingsSchema = z
  .object({
    zones: z.array(
      z.object({
        id: z.uuid(),
        name: z.string(),
        position: z.number().int(),
        countries: z.array(z.object({ country: z.string(), provinces: z.array(z.string()), postalPrefixes: z.array(z.string()) })),
        rates: z.array(shippingRateAdmin),
      }),
    ),
    localRates: z.array(shippingRateAdmin),
  })
  .meta({ id: "ShippingSettings" });

export const couriersSchema = z
  .object({
    couriers: z.array(z.object({ id: z.string(), name: z.string(), country: z.string().nullable() })),
    carriers: z.array(z.object({ id: z.string(), displayName: z.string() })),
  })
  .meta({ id: "Couriers" });

// ── Tax ────────────────────────────────────────────────────────────────────
export const taxSettingsSchema = z
  .object({
    rates: z.array(z.object({ id: z.uuid(), country: z.string(), province: z.string().nullable(), name: z.string(), rateBps: z.number().int() })),
    overrides: z.array(z.object({ id: z.uuid(), collectionId: z.uuid(), country: z.string().nullable(), province: z.string().nullable(), rateBps: z.number().int() })),
  })
  .meta({ id: "TaxSettings" });

// ── Refunds ────────────────────────────────────────────────────────────────
export const refundCalculationSchema = z
  .object({ subtotal: money, tax: money, shipping: money, shippingLeft: money, suggested: money, refundable: money })
  .meta({ id: "RefundCalculation" });

// ── Gift cards ─────────────────────────────────────────────────────────────
const giftCardBase = {
  id: z.uuid(),
  lastCharacters: z.string(),
  maskedCode: z.string(),
  currency: z.string(),
  initialValue: money,
  balance: money,
  customerId: z.uuid().nullable(),
  orderId: z.uuid().nullable(),
  recipientEmail: z.string().nullable(),
  note: z.string().nullable(),
  expiresAt: iso.nullable(),
  disabledAt: iso.nullable(),
  status: z.enum(["active", "disabled", "expired", "used"]),
  createdAt: iso,
};
export const giftCardSchema = z.object(giftCardBase).meta({ id: "GiftCard" });
export const giftCardIssuedSchema = z.object({ ...giftCardBase, code: z.string() }).meta({ id: "GiftCardIssued" });
export const giftCardDetailSchema = z
  .object({
    ...giftCardBase,
    transactions: z.array(
      z.object({ id: z.uuid(), kind: z.string(), amount: money, balanceAfter: money, orderId: z.uuid().nullable(), note: z.string().nullable(), createdAt: iso }),
    ),
  })
  .meta({ id: "GiftCardDetail" });

// ── Returns ────────────────────────────────────────────────────────────────
export const returnListSchema = z
  .object({
    items: z.array(
      z.object({
        id: z.uuid(),
        orderId: z.uuid(),
        orderName: z.string().nullable(),
        email: z.string().nullable(),
        name: z.string(),
        status: z.enum(["requested", "approved", "declined", "received", "closed", "cancelled"]),
        requestedBy: z.enum(["customer", "staff"]),
        resolution: z.enum(["refund", "exchange", "none"]).nullable(),
        createdAt: iso,
      }),
    ),
  })
  .meta({ id: "ReturnList" });

// ── Reports ────────────────────────────────────────────────────────────────
const summary = z.object({
  orders: z.number().int(),
  grossSales: money,
  discounts: money,
  returns: money,
  netSales: money,
  shipping: money,
  taxes: money,
  totalSales: money,
  averageOrderValue: money,
  customers: z.number().int(),
  returningCustomers: z.number().int(),
  returningCustomerRate: z.number(),
  unitsSold: z.number().int(),
});
const daySeries = z.array(z.object({ day: z.string(), orders: z.number().int(), sales: money }));
const breakdown = z.array(z.object({ key: z.string(), orders: z.number().int(), sales: money }));
const topProducts = z.array(z.object({ productId: z.uuid().nullable(), title: z.string(), units: z.number().int(), sales: money }));

export const salesReportSchema = z
  .object({
    currency: z.string(),
    timezone: z.string(),
    range: z.object({ from: z.string(), to: z.string() }),
    compareRange: z.object({ from: z.string(), to: z.string() }).nullable(),
    current: summary,
    previous: summary.nullable(),
    changes: z.record(z.string(), z.number().nullable()).nullable(),
    daily: daySeries,
    previousDaily: daySeries.nullable(),
    topProducts,
    byChannel: breakdown,
    byPaymentMethod: breakdown,
    funnel: z.object({
      sessions: z.number().int(),
      pageViews: z.number().int(),
      addToCarts: z.number().int(),
      checkoutsStarted: z.number().int(),
      orders: z.number().int(),
      conversionRate: z.number().nullable(),
      cartToCheckout: z.number().nullable(),
      checkoutToOrder: z.number().nullable(),
    }),
  })
  .meta({ id: "SalesReport" });

export const dashboardSchema = z
  .object({
    currency: z.string(),
    totals: z.object({ orders: z.number().int(), items: z.number().int(), today: z.number().int(), last7Days: z.number().int(), last30Days: z.number().int() }),
    byStatus: z.object({
      toFulfil: z.number().int(),
      partiallyFulfilled: z.number().int(),
      fulfilled: z.number().int(),
      returned: z.number().int(),
      cancelled: z.number().int(),
      openReturns: z.number().int(),
    }),
    payments: z.object({ net: money, refunded: money, paidCount: z.number().int(), unpaidCount: z.number().int(), notCompleted: z.number().int() }),
    topProducts,
  })
  .meta({ id: "Dashboard" });

// ── Staff ──────────────────────────────────────────────────────────────────
export const roleSchema = z
  .object({ id: z.uuid(), key: z.string(), name: z.string(), isSystem: z.boolean(), permissions: z.array(z.string()), staffCount: z.number().int() })
  .meta({ id: "Role" });

export const permissionGroupsSchema = z.array(z.object({ label: z.string(), permissions: z.array(z.string()) })).meta({ id: "PermissionGroups" });

export const teamMemberSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    email: z.string(),
    role: z.string(),
    roleName: z.string(),
    roleId: z.uuid(),
    permissions: z.array(z.string()),
    totpEnabled: z.boolean(),
    twoFactorSetupRequired: z.boolean(),
    disabled: z.boolean(),
    lastLoginAt: z.string().nullable(),
    createdAt: iso,
  })
  .meta({ id: "TeamMember" });

export const inviteSchema = z
  .object({ id: z.uuid(), email: z.string(), name: z.string().nullable(), roleId: z.uuid(), roleName: z.string(), expiresAt: iso, expired: z.boolean(), createdAt: iso })
  .meta({ id: "StaffInvite" });

export const inviteInfoSchema = z.object({ email: z.string(), name: z.string().nullable(), storeName: z.string(), roleName: z.string() }).meta({ id: "StaffInviteInfo" });

export const auditPageSchema = z
  .object({
    items: z.array(
      z.object({
        id: z.uuid(),
        actorType: z.string(),
        actorId: z.uuid().nullable(),
        actorName: z.string().nullable(),
        actorEmail: z.string().nullable(),
        action: z.string(),
        resourceType: z.string().nullable(),
        resourceId: z.string().nullable(),
        ip: z.string().nullable(),
        metadata: z.record(z.string(), z.unknown()),
        createdAt: iso,
      }),
    ),
    nextCursor: z.string().nullable(),
    actions: z.array(z.string()),
  })
  .meta({ id: "AuditPage" });
