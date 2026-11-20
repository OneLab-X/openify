/* eslint-disable no-console -- CLI report */
/* global fetch */
// Lighthouse gate (Phase 5): mobile performance, accessibility, SEO (and best practices, reported)
// must be ≥ 90 on the home, a collection and a product page of the running stack.
//
//   E2E_BASE_URL=https://localhost:8443 pnpm --filter @shopkit/e2e lighthouse
//   LH_PATHS="/,/collections/x,/products/y" to choose pages; LH_MIN=0.9 to change the bar.
//
// Uses Playwright's Chromium (already installed for e2e) through the DevTools port.
import { mkdir, writeFile } from "node:fs/promises";
import { chromium } from "@playwright/test";
import lighthouse from "lighthouse";

const base = (process.env.E2E_BASE_URL ?? "https://localhost").replace(/\/$/, "");
const min = Number(process.env.LH_MIN ?? "0.9");
const port = 9333;
const REQUIRED = ["performance", "accessibility", "seo"];

async function discover() {
  if (process.env.LH_PATHS) return process.env.LH_PATHS.split(",").map((p) => p.trim());
  const xml = async (path) => (await fetch(`${base}${path}`)).text();
  const first = (text, prefix) => [...text.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => new URL(m[1]).pathname).find((p) => p.startsWith(prefix));
  const products = await xml("/sitemaps/products-1.xml").catch(() => "");
  const collections = await xml("/sitemaps/collections-1.xml").catch(() => "");
  return ["/", first(collections, "/collections/") ?? "/collections", first(products, "/products/")].filter(Boolean);
}

process.env.NODE_TLS_REJECT_UNAUTHORIZED ??= "0"; // local stack uses Caddy's internal CA
const browser = await chromium.launch({ args: [`--remote-debugging-port=${port}`, "--ignore-certificate-errors"] });
let failed = false;
try {
  const paths = await discover();
  await mkdir(new URL("../lighthouse-report/", import.meta.url), { recursive: true });
  for (const path of paths) {
    const url = `${base}${path}`;
    // Warm the server cache once so the audit measures a normal (cached) page view.
    await fetch(url).catch(() => undefined);
    const result = await lighthouse(url, { port, output: "html", logLevel: "error", onlyCategories: [...REQUIRED, "best-practices"], formFactor: "mobile" });
    const lhr = result.lhr;
    const scores = Object.fromEntries(Object.entries(lhr.categories).map(([k, c]) => [k, c.score]));
    const name = path === "/" ? "home" : path.replace(/^\//, "").replace(/[^a-z0-9]+/gi, "-");
    await writeFile(new URL(`../lighthouse-report/${name}.html`, import.meta.url), result.report);
    const bad = REQUIRED.filter((k) => (scores[k] ?? 0) < min);
    console.log(`${bad.length ? "✘" : "✓"} ${path}  ${Object.entries(scores).map(([k, v]) => `${k} ${Math.round((v ?? 0) * 100)}`).join("  ")}`);
    if (bad.length) {
      failed = true;
      for (const k of bad) {
        const audits = lhr.categories[k].auditRefs
          .map((r) => lhr.audits[r.id])
          .filter((a) => a.score !== null && a.score < 0.9 && a.scoreDisplayMode !== "informative" && a.scoreDisplayMode !== "notApplicable")
          .slice(0, 8);
        for (const a of audits) console.log(`    ${k}: ${a.id} (${a.score}) ${a.displayValue ?? ""}`);
      }
    }
  }
} finally {
  await browser.close();
}
process.exit(failed ? 1 : 0);
