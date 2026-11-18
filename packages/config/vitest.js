import { defineConfig } from "vitest/config";

/** Shared Vitest defaults. Integration tests (testcontainers) get long timeouts. */
export function shopkitVitest(overrides = {}) {
  return defineConfig({
    test: {
      environment: "node",
      include: ["src/**/*.test.ts", "test/**/*.test.ts"],
      testTimeout: 30_000,
      hookTimeout: 180_000,
      ...overrides,
    },
  });
}
