import { expect, test, type Page } from "@playwright/test";
import { psql } from "../fixtures/stack.js";

/**
 * Phase-5 acceptance (docs/prompts/05-storefront-themes.md "Done when"):
 *  - the merchant reorders home sections in the theme editor, previews the draft, publishes, and the
 *    live storefront changes without a rebuild;
 *  - with the consent banner on, no third-party analytics request is made before "Accept";
 *  - product pages carry valid Product JSON-LD; sitemaps, robots and handle redirects work.
 * Lighthouse ≥ 90 is checked by `pnpm --filter @shopkit/e2e lighthouse` (scripts/lighthouse.mjs).
 */
test.describe.configure({ mode: "serial" });

const OWNER = { email: "asha@shopkit.test", password: "violet-Trombone-47-sunrise" };
const THIRD_PARTY = /googletagmanager\.com|google-analytics\.com|connect\.facebook\.net|facebook\.com\/tr|posthog\.com/;
const sql = (q: string) => psql(q).trim();

async function signIn(page: Page) {
  await page.goto("/admin/login");
  await page.getByLabel("Email").fill(OWNER.email);
  await page.getByRole("textbox", { name: "Password", exact: true }).fill(OWNER.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: /^Welcome, / })).toBeVisible();
}

async function admin(page: Page, method: "PUT" | "POST" | "DELETE", url: string, data?: unknown) {
  const csrf = (await page.context().cookies()).find((c) => c.name === "sk_csrf")?.value ?? "";
  const res = await page.request.fetch(url, { method, ...(data !== undefined ? { data } : {}), headers: { "x-csrf-token": decodeURIComponent(csrf) } });
  expect(res.ok(), `${method} ${url}: ${await res.text()}`).toBe(true);
  return res.json() as Promise<Record<string, unknown>>;
}

const homeOrder = async (page: Page) => page.locator("main#main > [data-section-type]").evaluateAll((els) => els.map((e) => e.getAttribute("data-section-type")));

test("rearrange home sections in the theme editor, preview the draft, publish, live shop updates", async ({ page, browser }) => {
  await signIn(page);
  const shopper = await browser.newPage({ ignoreHTTPSErrors: true });
  await shopper.goto("/");
  const before = await homeOrder(shopper);
  expect(before[0]).toBe("slideshow");
  expect(before).toContain("newsletter");

  await page.goto("/admin/content/theme");
  await expect(page.getByRole("heading", { name: "Theme editor" })).toBeVisible();
  const preview = page.frameLocator('[data-testid="theme-preview"]');
  await expect(preview.getByText("Preview — draft theme")).toBeVisible({ timeout: 20_000 });

  // Keyboard drag and drop: focus the newsletter handle, lift, move to the top, drop.
  const row = page.getByTestId("section-row-newsletter");
  await row.getByRole("button", { name: "Drag to reorder" }).focus();
  await page.keyboard.press("Space");
  for (let i = 0; i < before.length; i++) await page.keyboard.press("ArrowUp");
  await page.keyboard.press("Space");
  await expect(page.getByRole("status").filter({ hasText: "Draft saved" })).toBeVisible({ timeout: 10_000 });

  // The draft shows in the preview…
  await expect(async () => {
    const order = await preview.locator("main#main > [data-section-type]").evaluateAll((els) => els.map((e) => e.getAttribute("data-section-type")));
    expect(order[0]).toBe("newsletter");
  }).toPass({ timeout: 15_000 });
  // …but not on the live shop.
  await shopper.reload();
  expect((await homeOrder(shopper))[0]).toBe("slideshow");

  page.once("dialog", (d) => void d.accept("Newsletter first"));
  await page.getByRole("button", { name: "Publish" }).click();
  await expect(page.getByText(/Published version \d+/)).toBeVisible();

  // The worker revalidates the storefront's `theme` cache tag: no rebuild, no restart.
  await expect(async () => {
    await shopper.reload();
    expect((await homeOrder(shopper))[0]).toBe("newsletter");
  }).toPass({ timeout: 20_000 });

  // Roll back from version history.
  await page.getByRole("button", { name: "Versions" }).click();
  page.once("dialog", (d) => void d.accept());
  await page.getByRole("button", { name: "Roll back to this" }).last().click();
  await expect(page.getByText(/is live again/)).toBeVisible();
  await expect(async () => {
    await shopper.reload();
    expect((await homeOrder(shopper))[0]).toBe("slideshow");
  }).toPass({ timeout: 20_000 });
  await shopper.close();
});

test("no third-party analytics request before consent; ecommerce events reach first-party analytics", async ({ page, browser }) => {
  await signIn(page);
  await admin(page, "PUT", "/api/admin/credentials/analytics/ga4/live", { config: { measurementId: "G-E2ETEST01" }, secrets: {} });
  await admin(page, "PUT", "/api/admin/credentials/analytics/meta-pixel/live", { config: { pixelId: "123456789012" }, secrets: {} });
  await admin(page, "PUT", "/api/admin/settings/analytics.consentBanner", { value: true });

  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const thirdParty: string[] = [];
  let firstParty = 0;
  context.on("request", (req) => {
    if (THIRD_PARTY.test(req.url())) thirdParty.push(req.url());
    if (req.url().includes("/api/storefront/events")) firstParty++;
  });
  // Never actually load the real trackers in CI; recording the attempt is the assertion.
  await context.route(THIRD_PARTY, (route) => route.fulfill({ status: 204, body: "" }));
  const shop = await context.newPage();

  await expect(async () => {
    await shop.goto("/");
    await expect(shop.getByTestId("consent-banner")).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 30_000 });
  const handle = sql("select handle from products where status = 'active' order by created_at limit 1");
  await shop.goto(`/products/${handle}`);
  await expect(shop.getByRole("button", { name: "Add to cart" })).toBeVisible();
  await shop.getByRole("button", { name: "Add to cart" }).click();
  await shop.waitForTimeout(2_000);
  expect(thirdParty, "third-party requests before consent").toEqual([]);
  expect(firstParty).toBeGreaterThan(0);
  expect(Number(sql("select count(*) from analytics_events where name in ('view_item','add_to_cart')"))).toBeGreaterThanOrEqual(2);

  await shop.getByRole("button", { name: "Accept" }).click();
  await expect.poll(() => thirdParty.some((u) => u.includes("googletagmanager.com"))).toBe(true);
  await expect.poll(() => thirdParty.some((u) => u.includes("connect.facebook.net"))).toBe(true);
  // The decision is remembered: the next page loads trackers without asking again.
  await shop.goto("/");
  await expect(shop.getByTestId("consent-banner")).toHaveCount(0);
  await context.close();

  await admin(page, "DELETE", "/api/admin/credentials/analytics/ga4/live");
  await admin(page, "DELETE", "/api/admin/credentials/analytics/meta-pixel/live");
});

test("SEO: Product JSON-LD, sitemap index, robots.txt and redirects for renamed handles", async ({ page, request }) => {
  const handle = sql("select handle from products where status = 'active' order by created_at limit 1");
  await page.goto(`/products/${handle}`);
  const ld = JSON.parse((await page.locator('script[type="application/ld+json"]').first().textContent())!) as { "@graph": Record<string, unknown>[] };
  const product = ld["@graph"].find((n) => n["@type"] === "Product")!;
  expect(product).toMatchObject({ name: expect.any(String), offers: expect.objectContaining({}) });
  const offers = product.offers as Record<string, unknown>;
  const offer = (offers["@type"] === "AggregateOffer" ? (offers.offers as Record<string, unknown>[])[0] : offers)!;
  expect(offer).toMatchObject({ "@type": "Offer", price: expect.stringMatching(/^\d+(\.\d+)?$/), priceCurrency: "INR", availability: expect.stringMatching(/^https:\/\/schema\.org\/(InStock|OutOfStock)$/) });
  expect(ld["@graph"].some((n) => n["@type"] === "BreadcrumbList")).toBe(true);
  await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", new RegExp(`/products/${handle}$`));
  await expect(page.locator('meta[property="og:title"]')).toHaveAttribute("content", /.+/);

  const index = await (await request.get("/sitemap.xml")).text();
  expect(index).toContain("<sitemapindex");
  expect(index).toMatch(/\/sitemaps\/products-1\.xml/);
  expect(await (await request.get("/sitemaps/products-1.xml")).text()).toContain(`/products/${handle}</loc>`);
  const robots = await (await request.get("/robots.txt")).text();
  expect(robots).toMatch(/Sitemap: .*\/sitemap\.xml/);
  expect(robots).toMatch(/Disallow: \/checkout/);

  await signIn(page);
  const id = sql(`select id from products where handle = '${handle}'`);
  const product0 = (await (await page.request.get(`/api/admin/products/${id}`)).json()) as Record<string, unknown>;
  const renamed = `${handle}-renamed`;
  const csrf = decodeURIComponent((await page.context().cookies()).find((c) => c.name === "sk_csrf")!.value);
  const put = await page.request.put(`/api/admin/products/${id}`, { data: { ...product0, handle: renamed }, headers: { "x-csrf-token": csrf } });
  expect(put.ok(), await put.text()).toBe(true);
  await expect(async () => {
    const res = await request.get(`/products/${handle}`, { maxRedirects: 0 });
    expect(res.status()).toBe(308);
    expect(res.headers().location).toMatch(new RegExp(`/products/${renamed}$`));
  }).toPass({ timeout: 15_000 });
  // Put the handle back for later suites (its redirect is removed automatically).
  await page.request.put(`/api/admin/products/${id}`, { data: { ...product0, handle }, headers: { "x-csrf-token": csrf } });
});

test("CMS: a page and a generated policy render with the theme", async ({ page, request }) => {
  await signIn(page);
  await admin(page, "POST", "/api/admin/pages", { title: "About us", bodyHtml: "<h2>Our story</h2><p>Made in Jaipur.</p><script>alert(1)</script>" });
  await admin(page, "POST", "/api/admin/policies/privacy/generate", { overwrite: true });
  await expect(async () => {
    await page.goto("/pages/about-us");
    await expect(page.getByRole("heading", { name: "About us", level: 1 })).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 20_000 });
  await expect(page.getByRole("heading", { name: "Our story" })).toBeVisible();
  expect(await page.locator("main script").count()).toBe(0);
  await page.goto("/policies/privacy-policy");
  await expect(page.getByRole("heading", { name: "Privacy policy", level: 1 })).toBeVisible();
  await expect(page.getByRole("contentinfo").getByRole("link", { name: "Privacy policy" })).toBeVisible();
  expect((await request.get("/pages/does-not-exist")).status()).toBe(404);
});
