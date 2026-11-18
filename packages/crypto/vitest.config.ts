import { shopkitVitest } from "@shopkit/config/vitest";

export default shopkitVitest({
  coverage: {
    provider: "v8",
    include: ["src/**/*.ts"],
    exclude: ["src/**/*.test.ts", "src/index.ts"],
    thresholds: { lines: 100, functions: 100, branches: 100, statements: 100 },
  },
});
