import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

export function envFile(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(`${repoRoot}.env`, "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
}

function compose(args: string[]): string {
  return execFileSync("docker", ["compose", ...args], { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

/** The most recent setup token printed by an api container (SPEC §5). */
export function setupToken(): string {
  const logs = compose(["logs", "--no-color", "api"]);
  const tokens = [...logs.matchAll(/Shopkit setup token: ([A-Za-z0-9_-]+)/g)].map((m) => m[1]!);
  if (!tokens.length) throw new Error("No setup token in api logs; is the stack fresh?");
  return tokens.at(-1)!;
}

export function psql(query: string): string {
  return compose(["exec", "-T", "postgres", "psql", "-U", "shopkit", "-d", "shopkit", "-At", "-c", query]);
}
