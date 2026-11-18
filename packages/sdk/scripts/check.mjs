// Fails when src/schema.d.ts is stale relative to openapi.json (run `pnpm openapi` to refresh).
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const out = join(mkdtempSync(join(tmpdir(), "sdk-")), "schema.d.ts");
execFileSync("pnpm", ["exec", "openapi-typescript", "openapi.json", "-o", out], { stdio: "ignore" });
const fresh = readFileSync(out, "utf8");
const current = readFileSync("src/schema.d.ts", "utf8");
let committedSpec = "";
try {
  committedSpec = execFileSync("git", ["show", "HEAD:packages/sdk/openapi.json"], { encoding: "utf8" });
} catch {
  // first commit: nothing to compare against
}
const spec = readFileSync("openapi.json", "utf8");
if (fresh !== current || (committedSpec && committedSpec !== spec)) {
  console.error("SDK is stale: run `pnpm openapi` and commit packages/sdk/openapi.json + src/schema.d.ts");
  process.exit(1);
}
console.warn("SDK is up to date");
