import { defineConfig, devices } from "@playwright/test";

/**
 * Runs against the docker compose stack (SPEC §15) with the e2e overlay. Start it on an empty volume:
 *   export COMPOSE_FILE=docker-compose.yml:docker-compose.e2e.yml
 *   docker compose down -v && ./scripts/install.sh
 * E2E_BASE_URL defaults to PUBLIC_URL from ../.env.
 */
export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "https://localhost",
    ignoreHTTPSErrors: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  // The catalog suite needs the store the wizard suite launches.
  projects: [
    { name: "setup", testMatch: /setup-wizard\.spec\.ts/, use: { ...devices["Desktop Chrome"] } },
    { name: "catalog", testMatch: /catalog\.spec\.ts/, dependencies: ["setup"], use: { ...devices["Desktop Chrome"] } },
    // Needs the e2e overlay (payment sandbox + Mailpit): COMPOSE_FILE=docker-compose.yml:docker-compose.e2e.yml
    { name: "checkout", testMatch: /checkout\.spec\.ts/, dependencies: ["catalog"], use: { ...devices["Desktop Chrome"] } },
    // Phase 4: fulfilment, returns and gift cards on top of the checkout suite's orders.
    { name: "operations", testMatch: /operations\.spec\.ts/, dependencies: ["checkout"], use: { ...devices["Desktop Chrome"] } },
  ],
});
