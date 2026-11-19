import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { psql } from "../fixtures/stack.js";

/**
 * Phase-3 acceptance (docs/prompts/03-checkout-orders.md "Done when"), against the compose stack
 * with docker-compose.e2e.yml (local Razorpay/Stripe sandbox + Mailpit):
 *  - buys a product end to end with Razorpay test mode and with Stripe test mode;
 *  - replaying the same webhook is a no-op; the confirmation email is sent exactly once;
 *    inventory is decremented exactly once; amounts tampered in the browser are ignored.
 * (The abandoned-checkout email with fake timers is an integration test in packages/core.)
 */
test.describe.configure({ mode: "serial" });

const OWNER = { email: "asha@shopkit.test", password: "violet-Trombone-47-sunrise" };
const SANDBOX = `http://127.0.0.1:${process.env.SANDBOX_HOST_PORT ?? "14200"}`;
const MAILPIT = `http://127.0.0.1:${process.env.MAILPIT_HOST_PORT ?? "18025"}`;
const PRICE = 79_900;
const HANDLE = "e2e-checkout-tee";

async function signIn(page: Page) {
  await page.goto("/admin/login");
  await page.getByLabel("Email").fill(OWNER.email);
  await page.getByRole("textbox", { name: "Password", exact: true }).fill(OWNER.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: /^Welcome, / })).toBeVisible();
}

/** Admin API call with the session + CSRF cookies of the signed-in page. */
async function admin(page: Page, method: "PUT" | "POST", url: string, data: unknown) {
  const csrf = (await page.context().cookies()).find((c) => c.name === "sk_csrf")?.value ?? "";
  const res = await page.request.fetch(url, { method, data, headers: { "x-csrf-token": decodeURIComponent(csrf) } });
  expect(res.ok(), `${method} ${url}: ${await res.text()}`).toBe(true);
  return res.json() as Promise<Record<string, unknown>>;
}

const sql = (q: string) => psql(q).trim();

async function stock() {
  const [available, committed] = sql(
    `select l.available || ',' || l.committed from inventory_levels l join inventory_items i on i.id = l.inventory_item_id
     join product_variants v on v.id = i.variant_id join products p on p.id = v.product_id where p.handle = '${HANDLE}'`,
  )
    .split(",")
    .map(Number);
  return { available, committed };
}

async function latestOrder(email: string) {
  const [id, name] = sql(`select id || '|' || name from orders where email = '${email}' and placed_at is not null order by placed_at desc limit 1`).split("|");
  return { id: id!, name: name! };
}

async function waitForWebhook(request: APIRequestContext, provider: "razorpay" | "stripe", type: RegExp) {
  let found: { body: string; headers: Record<string, string>; status: number } | undefined;
  await expect(async () => {
    const events = (await (await request.get(`${SANDBOX}/_events?provider=${provider}`)).json()) as { body: string; headers: Record<string, string>; status: number }[];
    found = events.filter((e) => type.test(e.body) && e.status === 200).at(-1);
    expect(found).toBeTruthy();
  }).toPass({ timeout: 15_000 });
  return found!;
}

async function expectOneConfirmation(request: APIRequestContext, orderId: string, email: string) {
  await expect(async () => {
    expect(sql(`select count(*) from email_deliveries where idempotency_key = 'order:${orderId}:order_confirmation' and status = 'sent'`)).toBe("1");
  }).toPass({ timeout: 20_000 });
  const search = await request.get(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${email} subject:confirmed`)}`);
  expect(((await search.json()) as { messages_count: number }).messages_count).toBe(1);
}

/** Cart → checkout with contact + address; returns the checkout page. */
async function toCheckout(page: Page, email: string) {
  await expect(async () => {
    await page.goto(`/products/${HANDLE}`);
    await expect(page.getByRole("button", { name: "Add to cart" })).toBeEnabled({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  await page.getByRole("button", { name: "Add to cart" }).click();
  await expect(page.getByText("Added to your cart")).toBeVisible();
  await expect(page.getByTestId("cart-link")).toContainText("1");
  await page.getByTestId("cart-link").click();
  await expect(page.getByTestId("cart-line")).toHaveCount(1);
  await page.getByRole("button", { name: "Check out" }).click();
  await expect(page).toHaveURL(/\/checkout\?id=/);
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("First name").fill("Meera");
  await page.getByLabel("Last name").fill("Rao");
  await page.getByLabel("Address", { exact: true }).fill("4 Residency Road");
  await page.getByLabel("City").fill("Bengaluru");
  await page.getByLabel("State / province").fill("Karnataka");
  await page.getByLabel("Postal code").fill("560025");
  await page.getByLabel("Postal code").blur();
  await expect(page.getByTestId("checkout-total")).toHaveText("₹799.00");
}

test("setup: sandbox payment keys, Mailpit email and a product with stock", async ({ page }) => {
  await signIn(page);
  await admin(page, "PUT", "/api/admin/credentials/payment/razorpay/test", { config: { keyId: "rzp_test_e2eKey123" }, secrets: { webhookSecret: "e2e_rzp_webhook_secret" } });
  await admin(page, "PUT", "/api/admin/credentials/payment/stripe/test", {
    config: { publishableKey: "pk_test_e2eSandbox" },
    secrets: { secretKey: "sk_test_e2eSandbox", webhookSecret: "whsec_e2e_sandbox_secret" },
  });
  await admin(page, "PUT", "/api/admin/credentials/email/smtp/live", { config: { host: "mailpit", port: 1025, secure: false, fromEmail: "shop@shopkit.test" }, secrets: {} });
  await admin(page, "PUT", "/api/admin/settings/email.active", { value: { provider: "smtp", mode: "live" } });
  await admin(page, "PUT", "/api/admin/settings/payments.mode", { value: "test" });
  await admin(page, "POST", "/api/admin/products", { title: "E2E Checkout Tee", handle: HANDLE, status: "active", variants: [{ options: [], price: PRICE, inventory: [{ available: 10 }] }] });
  expect(await stock()).toEqual({ available: 10, committed: 0 });
});

test("buys with Razorpay test mode; tampered amount ignored; webhook replay is a no-op", async ({ page, request }) => {
  const email = "meera.rzp@example.com";
  await toCheckout(page, email);
  await page.getByRole("radio", { name: "Razorpay" }).check();

  // The browser tries to pay ₹0.01 in USD: the API ignores request-body amounts.
  await page.route("**/payment-session", (route) => route.continue({ postData: JSON.stringify({ amount: 1, currency: "USD", total: 1 }), headers: { ...route.request().headers(), "content-type": "application/json" } }));
  await page.getByRole("button", { name: /^Pay now/ }).click();
  const widget = page.getByRole("dialog", { name: "Razorpay sandbox" });
  await expect(widget.getByTestId("rzp-amount")).toHaveText("INR 799.00");
  await widget.getByRole("button", { name: "Pay now" }).click();

  await expect(page.getByRole("heading", { name: "Thank you for your order!" })).toBeVisible();
  await expect(page.getByTestId("financial-status")).toHaveText("Paid");
  await expect(page.getByTestId("order-total")).toHaveText("₹799.00");
  const orders = (await (await request.get(`${SANDBOX}/_orders`)).json()) as { razorpay: { amount: number; currency: string }[] };
  expect(orders.razorpay.at(-1)).toMatchObject({ amount: PRICE, currency: "INR" });

  const order = await latestOrder(email);
  const hook = await waitForWebhook(request, "razorpay", /payment\.captured/);
  const replay = await request.post("/api/webhooks/payments/razorpay", { data: hook.body, headers: { ...hook.headers, "content-type": "application/json" } });
  expect(await replay.json()).toEqual({ ok: true, outcome: "duplicate" });

  expect(sql(`select count(*) from transactions where order_id = '${order.id}' and status = 'success'`)).toBe("1");
  expect(await stock()).toEqual({ available: 9, committed: 1 });
  expect(sql(`select count(*) from inventory_adjustments where note = 'Order ${order.id}'`)).toBe("2");
  await expectOneConfirmation(request, order.id, email);
});

test("buys with Stripe test mode after a declined card; webhook replay is a no-op", async ({ page, request }) => {
  const email = "meera.stripe@example.com";
  await toCheckout(page, email);
  await page.getByRole("radio", { name: "Stripe" }).check();
  await page.getByRole("button", { name: /^Pay now/ }).click();
  const card = page.getByTestId("stripe-card");
  await card.fill("4000 0000 0000 0002");
  await page.getByRole("button", { name: "Pay ₹799.00" }).click();
  await expect(page.getByText("Your card was declined.")).toBeVisible();
  await card.fill("4242 4242 4242 4242");
  await page.getByRole("button", { name: "Pay ₹799.00" }).click();

  await expect(page.getByRole("heading", { name: "Thank you for your order!" })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("financial-status")).toHaveText("Paid");
  const order = await latestOrder(email);
  const hook = await waitForWebhook(request, "stripe", /payment_intent\.succeeded/);
  const replay = await request.post("/api/webhooks/payments/stripe", { data: hook.body, headers: { ...hook.headers, "content-type": "application/json" } });
  expect(await replay.json()).toEqual({ ok: true, outcome: "duplicate" });

  expect(sql(`select count(*) from transactions where order_id = '${order.id}' and status = 'success'`)).toBe("1");
  expect(await stock()).toEqual({ available: 8, committed: 2 });
  await expectOneConfirmation(request, order.id, email);
});

test("staff see both orders and refund the Stripe one through the provider", async ({ page }) => {
  await signIn(page);
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Orders" }).click();
  await expect(page.getByRole("heading", { name: "Orders", exact: true })).toBeVisible();
  const stripeOrder = await latestOrder("meera.stripe@example.com");
  const rzpOrder = await latestOrder("meera.rzp@example.com");
  await expect(page.getByRole("link", { name: rzpOrder.name, exact: true })).toBeVisible();
  await page.getByRole("link", { name: stripeOrder.name, exact: true }).click();
  await expect(page.getByRole("heading", { name: stripeOrder.name })).toBeVisible();
  await page.getByRole("button", { name: "Refund", exact: true }).click();
  await page.getByRole("button", { name: /^Refund ₹799\.00$/ }).click();
  await expect(page.getByText("Refund issued")).toBeVisible();
  await expect(page.getByText("Refunded", { exact: true }).first()).toBeVisible();
  expect(sql(`select financial_status from orders where id = '${stripeOrder.id}'`)).toBe("refunded");
});
