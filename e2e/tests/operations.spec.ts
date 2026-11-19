import { expect, test, type Page } from "@playwright/test";
import { psql } from "../fixtures/stack.js";

/**
 * Phase-4 flows in the browser (the status/inventory matrix is the integration test in
 * packages/core): staff fulfil the Razorpay order from the checkout suite with a courier AWB, the
 * shopper asks for a return on the status page, staff approve, receive (restock) and refund it;
 * a gift card covering the whole order checks out with no payment provider.
 */
test.describe.configure({ mode: "serial" });

const OWNER = { email: "asha@shopkit.test", password: "violet-Trombone-47-sunrise" };
const HANDLE = "e2e-checkout-tee";
const sql = (q: string) => psql(q).trim();

async function signIn(page: Page) {
  await page.goto("/admin/login");
  await page.getByLabel("Email").fill(OWNER.email);
  await page.getByRole("textbox", { name: "Password", exact: true }).fill(OWNER.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: /^Welcome, / })).toBeVisible();
}

const available = () => Number(sql(`select l.available from inventory_levels l join inventory_items i on i.id = l.inventory_item_id join product_variants v on v.id = i.variant_id join products p on p.id = v.product_id where p.handle = '${HANDLE}'`));

test("fulfil with a courier AWB, return requested by the shopper, received and refunded", async ({ page, context }) => {
  const [orderId, orderName] = sql(`select id || '|' || name from orders where email = 'meera.rzp@example.com' and placed_at is not null order by placed_at desc limit 1`).split("|");
  await signIn(page);
  await expect(page.getByText("Total orders")).toBeVisible();
  await page.goto(`/admin/orders/${orderId}`);
  await expect(page.getByRole("heading", { name: orderName })).toBeVisible();

  await page.getByRole("button", { name: "Fulfil items" }).click();
  await page.getByLabel("Courier", { exact: true }).selectOption("delhivery");
  await page.getByLabel("AWB / tracking number").fill("E2EAWB12345");
  await page.getByRole("button", { name: /^Fulfil 1 item/ }).click();
  await expect(page.getByText("Items fulfilled")).toBeVisible();
  await expect(page.getByRole("link", { name: "Track package" })).toHaveAttribute("href", /delhivery\.com.*E2EAWB12345/);
  await expect(page.getByRole("button", { name: "Print label (A6)" })).toBeVisible();
  await page.getByRole("button", { name: "Mark delivered" }).click();
  await expect(page.getByText("Marked as delivered")).toBeVisible();
  expect(sql(`select fulfillment_status from orders where id = '${orderId}'`)).toBe("fulfilled");

  // The shopper opens the status link and asks for a return.
  const statusUrl = await page.getByRole("link", { name: "Customer status page" }).getAttribute("href");
  const shopper = await context.browser()!.newContext({ ignoreHTTPSErrors: true });
  const sp = await shopper.newPage();
  await sp.goto(new URL(statusUrl!).pathname);
  await expect(sp.getByRole("heading", { name: "Shipments" })).toBeVisible();
  await sp.getByRole("button", { name: "Request a return" }).click();
  await sp.getByLabel(/How many E2E Checkout Tee to return/).fill("1");
  await sp.getByRole("button", { name: "Send request" }).click();
  await expect(sp.getByRole("status")).toContainText("Return requested");
  await shopper.close();

  const before = available();
  await page.reload();
  await page.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByText("Return approved")).toBeVisible();
  await page.getByRole("button", { name: "Mark received" }).click();
  await expect(page.getByText("Items received and restocked")).toBeVisible();
  expect(available()).toBe(before + 1);
  await page.getByRole("button", { name: "Refund or exchange" }).click();
  await page.getByRole("button", { name: "Confirm" }).click();
  await expect(page.getByText("Return refunded")).toBeVisible();
  await expect(async () => {
    expect(sql(`select financial_status || ',' || fulfillment_status from orders where id = '${orderId}'`)).toBe("refunded,returned");
  }).toPass({ timeout: 15_000 });
});

test("a gift card pays for a whole order without a payment provider", async ({ page, context }) => {
  await signIn(page);
  await page.goto("/admin/gift-cards");
  await page.getByLabel(/^Value/).fill("1000");
  await page.getByRole("button", { name: "Issue gift card" }).click();
  const code = (await page.locator("strong.font-mono").textContent())!.trim();
  expect(code).toMatch(/^[A-Z0-9-]{12,}$/);

  const shopper = await context.browser()!.newContext({ ignoreHTTPSErrors: true });
  const sp = await shopper.newPage();
  await sp.goto(`/products/${HANDLE}`);
  await sp.getByRole("button", { name: "Add to cart" }).click();
  await expect(sp.getByText("Added to your cart")).toBeVisible();
  await sp.goto("/cart");
  await sp.getByRole("button", { name: "Check out" }).click();
  await sp.getByLabel("Email", { exact: true }).fill("gift.buyer@example.com");
  await sp.getByLabel("First name").fill("Gita");
  await sp.getByLabel("Last name").fill("Rao");
  await sp.getByLabel("Address", { exact: true }).fill("4 Residency Road");
  await sp.getByLabel("City").fill("Bengaluru");
  await sp.getByLabel("State / province").fill("Karnataka");
  await sp.getByLabel("Postal code").fill("560025");
  await sp.getByLabel("Postal code").blur();
  await expect(sp.getByTestId("checkout-total")).toHaveText("₹799.00");
  await sp.getByLabel("Gift card code").fill(code);
  await sp.getByLabel("Gift card code").press("Enter");
  await expect(sp.getByTestId("checkout-due")).toHaveText("₹0.00");
  await sp.getByRole("button", { name: "Place order" }).click();
  await expect(sp.getByRole("heading", { name: "Thank you for your order!" })).toBeVisible({ timeout: 20_000 });
  await shopper.close();
  expect(sql(`select balance from gift_cards where last_characters = '${code.replace(/-/g, "").slice(-4)}'`)).toBe("20100");
});
