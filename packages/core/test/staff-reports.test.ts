import { eq, orders, outboxEvents, staffUsers } from "@shopkit/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { login, staffView, ensureSystemRoles } from "../src/auth/staff.js";
import { acceptInvite, deleteRole, describeInvite, inviteStaff, listInvites, listRoles, listTeam, revokeInvite, saveRole, searchAudit, updateSecurity, updateStaffMember } from "../src/auth/team.js";
import { addCartLines, getOrCreateCart } from "../src/commerce/carts.js";
import { createPaymentSession, handlePaymentWebhook, startCheckout, updateCheckout } from "../src/commerce/checkout.js";
import { refundOrder } from "../src/commerce/refunds.js";
import { comparisonRange, dashboardCards, reportCsv, rollupAnalyticsDay, salesReport } from "../src/reports.js";
import { ADDRESS, commerceStore, orderRow, pay } from "./commerce-fixtures.js";
import { ACTOR, makeDeps, type TestDeps } from "./harness.js";

let deps: TestDeps;
beforeAll(async () => {
  deps = await makeDeps();
  const { fakepay } = await import("./commerce-fixtures.js");
  deps.registry.register(fakepay);
});
afterAll(() => deps.close());
beforeEach(() => deps.reset());

const STRONG = "correct horse battery staple 42";

describe("staff", () => {
  it("invites by email, accepts with a strong password, and signs in with the invited role", async () => {
    const { storeId } = await commerceStore(deps);
    const roleId = await saveRole(deps, ACTOR, storeId, { name: "Packer", permissions: ["orders:read", "orders:fulfill"] });
    const { acceptUrl } = await inviteStaff(deps, ACTOR, storeId, { email: "packer@pls.test", roleId });
    const token = acceptUrl.split("/").at(-1)!;
    const [event] = await deps.db.select().from(outboxEvents).where(eq(outboxEvents.type, "staff.invited"));
    expect(event!.payload).toMatchObject({ email: "packer@pls.test", acceptUrl: "https://shop.test/admin/invite/" + token });
    expect(await describeInvite(deps, token)).toMatchObject({ email: "packer@pls.test", roleName: "Packer" });
    await expect(acceptInvite(deps, token, { name: "Pat", password: "password" })).rejects.toThrow();
    await acceptInvite(deps, token, { name: "Pat", password: STRONG });
    await expect(acceptInvite(deps, token, { name: "Pat", password: STRONG })).rejects.toThrow(/not found/i);
    const result = await login(deps, storeId, { email: "packer@pls.test", password: STRONG }, ACTOR);
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.staff.permissions.sort()).toEqual(["orders:fulfill", "orders:read"]);
    expect((await listRoles(deps.db, storeId)).find((r) => r.id === roleId)!.staffCount).toBe(1);
    await expect(deleteRole(deps, ACTOR, storeId, roleId)).rejects.toThrow(/Move the staff/);
    await expect(inviteStaff(deps, ACTOR, storeId, { email: "packer@pls.test", roleId })).rejects.toThrow(/already has/);
  });

  it("revokes invites, refuses the owner role, disables accounts", async () => {
    const { storeId } = await commerceStore(deps);
    const ids = await ensureSystemRoles(deps.db, storeId);
    await expect(inviteStaff(deps, ACTOR, storeId, { email: "x@pls.test", roleId: ids.owner })).rejects.toThrow(/one owner/);
    const inv = await inviteStaff(deps, ACTOR, storeId, { email: "y@pls.test", roleId: ids.staff });
    expect(await listInvites(deps.db, storeId)).toHaveLength(1);
    await revokeInvite(deps, ACTOR, storeId, inv.id);
    expect(await listInvites(deps.db, storeId)).toHaveLength(0);
    await expect(describeInvite(deps, inv.acceptUrl.split("/").at(-1)!)).rejects.toThrow(/not found/i);

    const again = await inviteStaff(deps, ACTOR, storeId, { email: "z@pls.test", roleId: ids.staff });
    const { staffId } = await acceptInvite(deps, again.acceptUrl.split("/").at(-1)!, { name: "Zed", password: STRONG });
    await updateStaffMember(deps, ACTOR, storeId, staffId, { disabled: true });
    await expect(login(deps, storeId, { email: "z@pls.test", password: STRONG }, ACTOR)).rejects.toThrow(/incorrect/);
    expect((await listTeam(deps.db, storeId)).find((s) => s.id === staffId)!.disabled).toBe(true);
  });

  it("enforcing 2FA requires it on your own account first and flags staff without it", async () => {
    const { storeId } = await commerceStore(deps);
    const ids = await ensureSystemRoles(deps.db, storeId);
    const inv = await inviteStaff(deps, ACTOR, storeId, { email: "a@pls.test", roleId: ids.admin });
    const { staffId } = await acceptInvite(deps, inv.acceptUrl.split("/").at(-1)!, { name: "Ann", password: STRONG });
    await expect(updateSecurity(deps, { type: "staff", id: staffId }, storeId, { requireTwoFactor: true })).rejects.toThrow(/your own account/);
    await deps.db.update(staffUsers).set({ totpEnabled: true }).where(eq(staffUsers.id, staffId));
    await updateSecurity(deps, { type: "staff", id: staffId }, storeId, { requireTwoFactor: true });
    const [other] = await deps.db.select().from(staffUsers).where(eq(staffUsers.email, "a@pls.test"));
    expect((await staffView(deps.db, other!)).twoFactorSetupRequired).toBe(false);
    await deps.db.update(staffUsers).set({ totpEnabled: false }).where(eq(staffUsers.id, staffId));
    const [again] = await deps.db.select().from(staffUsers).where(eq(staffUsers.id, staffId));
    expect((await staffView(deps.db, again!)).twoFactorSetupRequired).toBe(true);
  });

  it("filters the audit log by action, resource and actor, with cursor paging", async () => {
    const { storeId } = await commerceStore(deps);
    for (let i = 0; i < 3; i++) await saveRole(deps, { type: "staff", id: null }, storeId, { name: `Role ${i}`, permissions: [] });
    const roles = await searchAudit(deps.db, storeId, { action: "role.", limit: 2 });
    expect(roles.items.map((r) => r.action)).toEqual(["role.created", "role.created"]);
    expect(roles.nextCursor).toBeTruthy();
    const next = await searchAudit(deps.db, storeId, { action: "role.", limit: 2, cursor: roles.nextCursor! });
    expect(next.items).toHaveLength(1);
    expect(roles.actions).toContain("role.created");
    expect((await searchAudit(deps.db, storeId, { resourceType: "role", from: new Date(Date.now() + 60_000) })).items).toHaveLength(0);
  });
});

describe("reports", () => {
  async function placeOn(storeId: string, variantId: string, quantity: number, day: string, email = "asha@example.com") {
    const { cart, token } = await getOrCreateCart(deps, storeId, undefined);
    await addCartLines(deps, storeId, cart, { lines: [{ variantId, quantity }] });
    const checkout = await startCheckout(deps, storeId, cart);
    await updateCheckout(deps, storeId, checkout, cart, { email, shippingAddress: ADDRESS, paymentProvider: "fakepay" });
    const s = await createPaymentSession(deps, storeId, checkout.id, token);
    const hook = pay(String(s.clientPayload.orderId)).webhook();
    await handlePaymentWebhook(deps, "fakepay", hook.body, hook.headers);
    await deps.db.update(orders).set({ placedAt: new Date(`${day}T10:00:00Z`) }).where(eq(orders.id, s.orderId));
    return orderRow(deps, s.orderId);
  }

  it("computes sales, AOV, returning customers, top products, breakdowns, comparison and CSV", async () => {
    const { storeId, variants } = await commerceStore(deps);
    const a = await placeOn(storeId, variants[0]!.id, 1, "2026-10-05"); // previous period
    const b = await placeOn(storeId, variants[0]!.id, 2, "2026-11-02");
    const c = await placeOn(storeId, variants[2]!.id, 1, "2026-11-03", "new@example.com");
    await refundOrder(deps, ACTOR, storeId, c.id, { amount: 10_000 });

    const r = await salesReport(deps.db, storeId, { from: "2026-11-01", to: "2026-11-30" });
    expect(r.compareRange).toEqual({ from: "2026-10-02", to: "2026-10-31" });
    expect(r.current).toMatchObject({
      orders: 2,
      grossSales: 199_800 + 109_900,
      returns: 10_000,
      netSales: 199_800 + 109_900 - 10_000,
      taxes: b.taxTotal + c.taxTotal,
      shipping: b.shippingTotal + c.shippingTotal,
      customers: 2,
      returningCustomers: 1,
      returningCustomerRate: 50,
      unitsSold: 3,
    });
    expect(r.current.totalSales).toBe(b.total + c.total - 10_000);
    expect(r.current.averageOrderValue).toBe(Math.round((b.total + c.total) / 2));
    expect(r.previous).toMatchObject({ orders: 1, grossSales: 99_900 });
    expect(r.changes!.orders).toBe(100);
    expect(r.topProducts[0]).toMatchObject({ units: 3 });
    expect(r.byChannel).toEqual([{ key: "web", orders: 2, sales: b.total + c.total - 10_000 }]);
    expect(r.byPaymentMethod[0]!.key).toBe("fakepay");
    expect(r.daily).toHaveLength(30);
    expect(r.daily.find((d) => d.day === "2026-11-02")).toEqual({ day: "2026-11-02", orders: 1, sales: b.total });
    void a;

    const csv = await reportCsv(deps.db, storeId, { from: "2026-11-01", to: "2026-11-30", kind: "orders" });
    expect(csv.filename).toBe("orders-2026-11-01-to-2026-11-30.csv");
    expect(csv.csv.split("\n")[0]).toMatch(/^Order,Placed at,Email/);
    expect(csv.csv.trim().split("\n")).toHaveLength(3);
    const byDay = await reportCsv(deps.db, storeId, { from: "2026-11-02", to: "2026-11-03", kind: "sales_by_day" });
    expect(byDay.csv).toBe(`Day,Orders,Net sales (INR)\n2026-11-02,1,${(b.total / 100).toFixed(2)}\n2026-11-03,1,${((c.total - 10_000) / 100).toFixed(2)}\n`);

    expect(comparisonRange({ from: "2026-11-01", to: "2026-11-30", compare: "previous_year" })).toEqual({ from: "2025-11-01", to: "2025-11-30" });
  });

  it("rolls up analytics_daily for the funnel and fills the PLS dashboard cards", async () => {
    const { storeId, variants } = await commerceStore(deps);
    const today = new Date().toISOString().slice(0, 10);
    const o = await placeOn(storeId, variants[0]!.id, 1, today);
    await deps.db.update(orders).set({ placedAt: new Date() }).where(eq(orders.id, o.id));
    const rolled = await rollupAnalyticsDay(deps.db, storeId, today);
    expect(rolled).toMatchObject({ addToCarts: 1, checkoutsStarted: 1, orders: 1, revenue: o.total });
    const report = await salesReport(deps.db, storeId, { from: today, to: today, compare: "none" });
    expect(report.funnel).toMatchObject({ addToCarts: 1, checkoutsStarted: 1, orders: 1, cartToCheckout: 100, checkoutToOrder: 100, conversionRate: null });
    const cards = await dashboardCards(deps.db, storeId);
    expect(cards.totals).toMatchObject({ orders: 1, items: 1, today: 1, last7Days: 1, last30Days: 1 });
    expect(cards.byStatus.toFulfil).toBe(1);
    expect(cards.payments).toMatchObject({ net: o.total, paidCount: 1 });
  });
});
