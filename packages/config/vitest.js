import { execFileSync } from "node:child_process";
import { defineConfig } from "vitest/config";

/**
 * testcontainers only probes the default socket paths. When DOCKER_HOST is unset, take the
 * endpoint of the active `docker context` (Colima, OrbStack, Rancher…) so integration tests
 * work with whatever runtime the developer's docker CLI already uses.
 */
function useActiveDockerContext() {
  if (process.env.DOCKER_HOST) return;
  try {
    const host = execFileSync("docker", ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!host || host === "unix:///var/run/docker.sock") return;
    process.env.DOCKER_HOST = host;
    // Ryuk mounts the socket from inside the VM, where it lives at the standard path.
    process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE ??= "/var/run/docker.sock";
  } catch {
    // no docker CLI: unit tests still run, integration tests report the runtime error
  }
}

/** Shared Vitest defaults. Integration tests (testcontainers) get long timeouts. */
export function shopkitVitest(overrides = {}) {
  useActiveDockerContext();
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
