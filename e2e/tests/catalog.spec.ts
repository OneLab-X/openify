import { expect, test, type Page } from "@playwright/test";
import { solidPng } from "../fixtures/png.js";
import { shopifyCsv } from "../fixtures/shopify-csv.js";
import { psql } from "../fixtures/stack.js";

/**
 * Phase-2 acceptance (docs/prompts/02-catalog.md "Done when"), run after the setup suite:
 *  - a product with 2 options, 6 variants and 4 images created in the admin appears on the
 *    storefront within 5 seconds, without a rebuild;
 *  - a 500-product Shopify CSV imports cleanly and re-importing is idempotent by handle.
 */
test.describe.configure({ mode: "serial" });

const OWNER = { email: "asha@shopkit.test", password: "violet-Trombone-47-sunrise" };

async function signIn(page: Page) {
  await page.goto("/admin/login");
  await page.getByLabel("Email").fill(OWNER.email);
  await page.getByRole("textbox", { name: "Password", exact: true }).fill(OWNER.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: /^Welcome, / })).toBeVisible();
}

/** Polls the storefront until `check` passes; returns the elapsed milliseconds since `since`. */
async function visibleWithin(page: Page, url: string, since: number, check: () => Promise<void>) {
  await expect(async () => {
    await page.goto(url);
    await check();
  }).toPass({ timeout: 15_000, intervals: [250] });
  return Date.now() - since;
}

test("a product with 2 options, 6 variants and 4 images reaches the storefront within 5 seconds", async ({ page, context }) => {
  await signIn(page);
  await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Products" }).click();
  await page.getByRole("link", { name: "Add product" }).click();
  await expect(page.getByRole("heading", { name: "Add product" })).toBeVisible();

  await page.getByRole("textbox", { name: "Title", exact: true }).fill("Ajrakh Block Print Kurta");
  await page.getByRole("textbox", { name: "Description", exact: true }).click();
  await page.keyboard.type("Hand block printed with natural dyes.");
  await page.getByLabel("Status", { exact: true }).selectOption("active");
  await page.getByLabel("Vendor", { exact: true }).fill("PLS Studio");
  await page.getByLabel("Product type", { exact: true }).fill("Kurta");
  await page.getByLabel("Tags", { exact: true }).fill("cotton, ajrakh");

  await page.getByRole("button", { name: "Add option" }).click();
  await page.getByLabel("Option 1 name").fill("Size");
  await page.getByLabel("Option 1 values").fill("S, M, L");
  await page.getByRole("button", { name: "Add values" }).first().click();
  await page.getByRole("button", { name: "Add option" }).click();
  await page.getByLabel("Option 2 name").fill("Colour");
  await page.getByLabel("Option 2 values").fill("Indigo, Madder");
  await page.getByRole("button", { name: "Add values" }).nth(1).click();
  await expect(page.getByRole("heading", { name: "Variants (6)" })).toBeVisible();

  await page.getByLabel("Price for all variants").fill("1499");
  await page.getByRole("button", { name: "Set all prices" }).click();
  await page.getByLabel("Price for L / Madder", { exact: true }).fill("1699");
  await page.getByLabel("Compare-at price for S / Indigo", { exact: true }).fill("1999");
  await page.getByLabel("SKU for S / Indigo", { exact: true }).fill("AJK-S-IND");
  await page.getByLabel("HSN code for S / Indigo", { exact: true }).fill("6211");
  await page.getByLabel("Quantity for S / Indigo", { exact: true }).fill("5");
  await page.getByLabel("Quantity for M / Madder", { exact: true }).fill("2");

  await page.getByLabel("Add images").setInputFiles(
    ([[180, 60, 40], [30, 60, 140], [200, 160, 40], [40, 120, 80]] as const).map((rgb, n) => ({
      name: `kurta-${n + 1}.png`,
      mimeType: "image/png",
      buffer: solidPng(400, 500, [...rgb]),
    })),
  );
  await expect(page.getByLabel(/^Alt text for image/)).toHaveCount(4, { timeout: 30_000 });
  await page.getByLabel("Alt text for image 1", { exact: true }).fill("Kurta front");
  await page.getByLabel("Alt text for image 1", { exact: true }).blur();
  await page.getByLabel("Image for M / Madder", { exact: true }).selectOption({ label: "Image 3" });

  const created = page.waitForResponse((r) => r.request().method() === "POST" && r.url().endsWith("/api/admin/products") && r.ok());
  await page.getByRole("button", { name: "Save product" }).click();
  await created;
  const savedAt = Date.now(); // measured from the API's answer, i.e. the committed write
  await expect(page.getByText("Product saved.")).toBeVisible();
  await expect(page).toHaveURL(/\/admin\/products\/[0-9a-f-]{36}\?saved=1$/);

  const shop = await context.newPage();
  const productMs = await visibleWithin(shop, "/products/ajrakh-block-print-kurta", savedAt, async () => {
    await expect(shop.getByRole("heading", { name: "Ajrakh Block Print Kurta", level: 1 })).toBeVisible({ timeout: 1_000 });
  });
  const homeMs = await visibleWithin(shop, "/", savedAt, async () => {
    await expect(shop.getByRole("link", { name: /Ajrakh Block Print Kurta/ })).toBeVisible({ timeout: 1_000 });
  });
  expect(productMs).toBeLessThan(5_000);
  expect(homeMs).toBeLessThan(5_000);

  // 2 options × 3/2 values, 4 images, the chosen variant's price and stock.
  await shop.goto("/products/ajrakh-block-print-kurta?variant=");
  await expect(shop.getByRole("group", { name: "Size" }).getByRole("radio")).toHaveCount(3);
  await expect(shop.getByRole("group", { name: "Colour" }).getByRole("radio")).toHaveCount(2);
  await expect(shop.getByRole("button", { name: /^Show image/ })).toHaveCount(4);
  await expect(shop.getByTestId("price")).toHaveText(/1,499/);
  await expect(shop.getByTestId("availability")).toHaveText(/In stock/);
  await shop.getByText("L", { exact: true }).click();
  await shop.getByText("Madder", { exact: true }).click();
  await expect(shop.getByTestId("price")).toHaveText(/1,699/);
  await expect(shop.getByTestId("availability")).toHaveText(/Sold out/);
  await expect(shop.getByText("Hand block printed with natural dyes.")).toBeVisible();
  expect(psql("select count(*) from product_variants v join products p on p.id = v.product_id where p.handle = 'ajrakh-block-print-kurta'").trim()).toBe("6");
  expect(psql("select count(*) from product_media pm join products p on p.id = pm.product_id where p.handle = 'ajrakh-block-print-kurta'").trim()).toBe("4");

  // Editing a cached product page: the new price shows within 5 seconds too.
  await page.getByLabel("Price for S / Indigo", { exact: true }).fill("1399");
  const saved = page.waitForResponse((r) => r.request().method() === "PUT" && /\/api\/admin\/products\//.test(r.url()) && r.ok());
  await page.getByRole("button", { name: "Save product" }).click();
  await saved;
  const editedAt = Date.now();
  const editMs = await visibleWithin(shop, "/products/ajrakh-block-print-kurta", editedAt, async () => {
    await expect(shop.getByTestId("price")).toHaveText(/1,399/, { timeout: 1_000 });
  });
  expect(editMs).toBeLessThan(5_000);

  // The worker generated WebP/AVIF renditions for the uploads.
  await expect(async () => {
    expect(Number(psql("select count(*) from media where jsonb_array_length(renditions) > 0").trim())).toBeGreaterThanOrEqual(4);
  }).toPass({ timeout: 30_000 });
});

test("a 500-product Shopify CSV imports cleanly and re-imports idempotently", async ({ page }) => {
  test.setTimeout(420_000);
  await signIn(page);
  await page.goto("/admin/products/import");
  const csv = Buffer.from(shopifyCsv(500));

  for (const [run, expected] of [
    [1, "500 created, 0 updated"],
    [2, "0 created, 500 updated"],
  ] as const) {
    await page.getByLabel("Product CSV file").setInputFiles({ name: `products_export_${run}.csv`, mimeType: "text/csv", buffer: csv });
    await page.getByRole("button", { name: "Start import" }).click();
    const job = page.getByRole("listitem").filter({ hasText: `products_export_${run}.csv` });
    await expect(job.getByText("completed")).toBeVisible({ timeout: 180_000 });
    await expect(job.getByText(`500 of 500 processed · ${expected}`)).toBeVisible();
    await expect(job.getByText(/error/)).toHaveCount(0);
  }
  expect(psql("select count(*) from products where handle like 'import-%'").trim()).toBe("500");
  expect(psql("select count(*) from product_variants v join products p on p.id = v.product_id where p.handle like 'import-%'").trim()).toBe("1500");
  expect(psql("select count(*) from inventory_adjustments where reason = 'import'").trim()).toBe("1500");
  expect(psql("select sum(total_inventory) from products where handle like 'import-%'").trim()).toBe(String(500 * (3 + 4 + 5)));
});

test("collections, filters, search and inventory work end to end", async ({ page, context }) => {
  await signIn(page);
  await page.goto("/admin/collections/new");
  await page.getByRole("textbox", { name: "Title", exact: true }).fill("Batch zero");
  await page.getByRole("radio", { name: /Automated/ }).check();
  await page.getByLabel("Condition 1 field").selectOption("tag");
  await page.getByLabel("Condition 1 value").fill("batch-0");
  await page.getByLabel("Sort products").selectOption("price_asc");
  await page.getByRole("button", { name: "Save collection" }).click();
  await expect(page.getByText("Collection saved (100 products).")).toBeVisible();

  const shop = await context.newPage();
  await expect(async () => {
    await shop.goto("/collections/batch-zero");
    await expect(shop.getByRole("heading", { name: "Batch zero", level: 1 })).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
  await expect(shop.getByRole("list", { name: "Products" }).getByRole("listitem")).toHaveCount(24);
  await expect(shop.getByRole("list", { name: "Products" }).getByRole("listitem").first()).toContainText("Imported Kurta 0");
  await shop.getByRole("checkbox", { name: /Size:|Large/ }).first().check();
  await shop.getByLabel("Minimum price").fill("1300");
  await shop.getByRole("button", { name: "Apply" }).click();
  await expect(shop).toHaveURL(/min=1300/);
  await expect(shop.getByRole("list", { name: "Products" }).getByRole("listitem").first()).toBeVisible();
  await shop.getByRole("link", { name: "Next page" }).click();
  await expect(shop).toHaveURL(/cursor=/);

  await shop.goto("/search?q=ajrak");
  await expect(shop.getByRole("link", { name: /Ajrakh Block Print Kurta/ })).toBeVisible();

  // Inventory: adjust one variant at the default location and see the ledger.
  await page.goto("/admin/inventory?q=AJK-S-IND");
  const row = page.getByRole("row").filter({ hasText: "AJK-S-IND" });
  await expect(row.getByRole("cell", { name: "5", exact: true })).toBeVisible();
  await row.getByRole("textbox", { name: /Change for/ }).fill("7");
  await page.getByLabel("Reason").selectOption("received");
  await page.getByRole("button", { name: "Save adjustments" }).click();
  await expect(page.getByText("Saved 1 adjustment(s).")).toBeVisible();
  await expect(row.getByRole("cell", { name: "12", exact: true })).toBeVisible();
  await row.getByRole("button", { name: "History" }).click();
  await expect(page.getByRole("cell", { name: "+7" })).toBeVisible();
});

test("bulk actions and saved views on the product list", async ({ page }) => {
  await signIn(page);
  await page.goto("/admin/products?q=Imported+Kurta+49&sort=title_asc");
  await expect(page.getByRole("link", { name: "Imported Kurta 49", exact: true })).toBeVisible();
  await page.getByRole("checkbox", { name: "Select Imported Kurta 49", exact: true }).check();
  await page.getByLabel("Tags to add or remove").fill("featured");
  await page.getByRole("button", { name: "Add tags" }).click();
  await expect(page.getByText("Updated 1 product(s).")).toBeVisible();
  expect(psql("select count(*) from product_tags pt join tags t on t.id = pt.tag_id where t.name = 'featured'").trim()).toBe("1");

  page.once("dialog", (d) => void d.accept("Kurta 49"));
  await page.getByRole("button", { name: "Save view" }).click();
  await expect(page.getByRole("navigation", { name: "Saved views" }).getByRole("link", { name: "Kurta 49" })).toBeVisible();

  await page.getByRole("checkbox", { name: "Select Imported Kurta 49", exact: true }).check();
  await page.getByRole("button", { name: "Archive" }).click();
  await expect(page.getByText("Updated 1 product(s).")).toBeVisible();
  expect(psql("select status from products where handle = 'import-49'").trim()).toBe("archived");
});
