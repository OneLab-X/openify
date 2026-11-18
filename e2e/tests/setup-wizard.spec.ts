import { expect, test, type Page } from "@playwright/test";
import { LOGO_PNG } from "../fixtures/logo.js";
import { psql, setupToken } from "../fixtures/stack.js";

/**
 * Phase-1 acceptance (docs/prompts/01-foundation.md "Done when"): runs against a stack started on an
 * empty volume. Serial: each test builds on the previous one.
 */
test.describe.configure({ mode: "serial" });

const OWNER = { name: "Asha Kumar", email: "asha@shopkit.test", password: "violet-Trombone-47-sunrise" };
const RZP_SECRET = "E2E_PLAINTEXT_SECRET_7731";

async function signIn(page: Page) {
  await page.goto("/admin/login");
  await page.getByLabel("Email").fill(OWNER.email);
  await page.getByRole("textbox", { name: "Password", exact: true }).fill(OWNER.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Welcome, Asha", exact: true })).toBeVisible();
}

test("storefront shows coming soon and setup endpoints need the token", async ({ page, request }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Coming soon", exact: true })).toBeVisible();

  expect((await request.get("/api/setup/status")).ok()).toBe(true);
  expect((await request.get("/api/setup/state")).status()).toBe(401);
  expect((await request.put("/api/setup/owner", { data: OWNER })).status()).toBe(401);
  expect((await request.post("/api/setup/launch")).status()).toBe(401);
  expect((await request.post("/api/setup/token", { data: { token: "not-the-token" } })).status()).toBe(401);
});

test("admin redirects to the setup wizard and completes every step", async ({ page }) => {
  await page.goto("/admin");
  await expect(page).toHaveURL(/\/admin\/setup$/);

  // Step 0: token
  await page.getByLabel("Setup token").fill("wrong-token");
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByText("That setup token is not valid")).toBeVisible();
  await page.getByLabel("Setup token").fill(setupToken());
  await page.getByRole("button", { name: "Continue" }).click();

  // Step 1: owner (weak password rejected first)
  await expect(page.getByRole("heading", { name: "Create the owner account", exact: true })).toBeVisible();
  await page.getByLabel("Your name").fill(OWNER.name);
  await page.getByLabel("Email").fill(OWNER.email);
  await page.getByRole("textbox", { name: "Password", exact: true }).fill("password123");
  await page.getByLabel("Confirm password").fill("password123");
  await page.getByRole("button", { name: "Save and continue" }).click();
  await expect(page.getByText(/Password is too weak/)).toBeVisible();
  await page.getByRole("textbox", { name: "Password", exact: true }).fill(OWNER.password);
  await page.getByLabel("Confirm password").fill(OWNER.password);
  await page.getByRole("button", { name: "Save and continue" }).click();

  // Step 2: storage — a failed and a successful Test connection
  await expect(page.getByRole("heading", { name: "Where should files be stored?", exact: true })).toBeVisible();
  await page.getByRole("radio", { name: "MinIO / S3-compatible" }).check();
  await page.getByLabel("Endpoint").fill("http://nowhere.invalid:9000");
  await page.getByLabel("Bucket").fill("shop");
  await page.getByLabel("Access key ID").fill("shopkit");
  await page.getByLabel("Secret access key").fill("wrong-secret-key");
  await page.getByRole("button", { name: "Test connection" }).click();
  await expect(page.getByText(/Connection failed/)).toBeVisible({ timeout: 30_000 });

  await page.getByRole("radio", { name: "Local disk" }).check();
  await page.getByRole("button", { name: "Test connection" }).click();
  await expect(page.getByText("Connection works.")).toBeVisible();
  await page.getByRole("button", { name: /Test & save/ }).click();

  // Step 3: store details + logo
  await expect(page.getByRole("heading", { name: "Store details", exact: true })).toBeVisible();
  await page.getByLabel("Logo").setInputFiles({ name: "logo.png", mimeType: "image/png", buffer: LOGO_PNG });
  await expect(page.getByRole("img", { name: "Current logo" })).toBeVisible();
  await page.getByLabel("Store name").fill("Pretty Little Store");
  await page.getByLabel("Store email").fill("hello@shopkit.test");
  await page.getByLabel("City").fill("Bengaluru");
  await page.getByLabel("Time zone").fill("Asia/Kolkata");
  await page.getByRole("button", { name: "Save and continue" }).click();

  // Step 4: payments — save Razorpay (secret must never be echoed) and COD
  await expect(page.getByRole("heading", { name: "Payments", exact: true })).toBeVisible();
  await page.getByRole("radio", { name: "Razorpay" }).check();
  await page.getByLabel("Key ID").fill("rzp_test_e2eKey123");
  await page.getByLabel("Key secret").fill(RZP_SECRET);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Razorpay saved.")).toBeVisible();
  await expect(page.getByLabel("Key secret")).toHaveValue("");
  await expect(page.getByLabel("Key secret")).toHaveAttribute("placeholder", /Saved ••••7731/);
  await expect(page.getByText("/api/webhooks/payments/razorpay")).toBeVisible();
  await page.getByRole("radio", { name: "Cash on Delivery" }).check();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Cash on Delivery saved.")).toBeVisible();
  await page.getByRole("button", { name: "Continue" }).click();

  // Steps 5–7: optional, skipped
  await expect(page.getByRole("heading", { name: "Email", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Skip for now" }).click();
  await expect(page.getByRole("heading", { name: "Analytics", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Skip for now" }).click();
  await expect(page.getByRole("heading", { name: "Shipping & tax", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Skip for now" }).click();

  // Step 8: review & launch
  await expect(page.getByRole("heading", { name: "Review & launch", exact: true })).toBeVisible();
  await expect(page.getByText(/razorpay \(test\)/)).toBeVisible();
  await expect(page.getByText(/cod \(live\)/)).toBeVisible();
  await page.getByRole("button", { name: "Launch store" }).click();

  // Admin shell loads, signed in as the owner
  await expect(page.getByRole("heading", { name: "Welcome, Asha", exact: true })).toBeVisible();
  for (const item of ["Home", "Orders", "Products", "Customers", "Content", "Analytics", "Settings"]) {
    await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: item })).toBeVisible();
  }
});

test("storefront shows the store name and logo", async ({ page }) => {
  await expect(async () => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Pretty Little Store", exact: true })).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  const logo = page.getByRole("img", { name: "Pretty Little Store logo" });
  await expect(logo).toBeVisible();
  expect(await logo.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
});

test("secrets are encrypted at rest and never returned by the API", async ({ page }) => {
  const dump = psql("select encode(ciphertext,'escape') || encode(wrapped_dek,'escape') || config::text from provider_credentials");
  expect(dump.length).toBeGreaterThan(0);
  expect(dump).not.toContain(RZP_SECRET);
  expect(psql("select count(*) from provider_credentials where kind = 'payment'").trim()).toBe("2");

  await signIn(page);
  await page.goto("/admin/settings/payments");
  const res = await page.request.get("/api/admin/credentials");
  expect(res.ok()).toBe(true);
  const body = await res.text();
  expect(body).toContain('"last4":"7731"');
  expect(body).not.toContain(RZP_SECRET);
  await page.getByRole("radio", { name: "Razorpay" }).check();
  await expect(page.getByLabel("Key ID")).toHaveValue("rzp_test_e2eKey123");
  await expect(page.getByLabel("Key secret")).toHaveValue("");
  await expect(page.getByLabel("Key secret")).toHaveAttribute("placeholder", /Saved ••••7731/);
});

test("setup endpoints reject requests after setup completes", async ({ request }) => {
  expect(await (await request.get("/api/setup/status")).json()).toEqual({ required: false, step: "review" });
  expect((await request.get("/api/setup/state")).status()).toBe(410);
  expect((await request.put("/api/setup/owner", { data: OWNER })).status()).toBe(410);
  expect((await request.post("/api/setup/token", { data: { token: "anything" } })).status()).toBe(410);
  expect((await request.post("/api/setup/launch")).status()).toBe(410);
});

test("settings pages and audit log render; sign out and back in", async ({ page }) => {
  await signIn(page);

  for (const [link, heading] of [
    ["General", "Store details"], ["Storage", "Storage"], ["Payments", "Payments"], ["Email", "Email"],
    ["Analytics", "Analytics"], ["Shipping & taxes", "Shipping & taxes"], ["Staff & security", "Your security"], ["Audit log", "Audit log"],
  ] as const) {
    await page.goto("/admin/settings");
    await page.getByRole("navigation", { name: "Settings" }).getByRole("link", { name: link }).click();
    await expect(page.getByRole("heading", { name: heading, exact: true }).first()).toBeVisible();
  }
  await expect(page.getByText("credential.created").first()).toBeVisible();
  await expect(page.getByText("store.launched")).toBeVisible();

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/admin\/login$/);
  await page.goto("/admin/settings/general");
  await expect(page).toHaveURL(/\/admin\/login$/);
});
