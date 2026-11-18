import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const apiOrigin = process.env.API_INTERNAL_URL;

const config: NextConfig = {
  basePath: "/admin",
  output: "standalone",
  // Monorepo: trace workspace packages from the repository root.
  outputFileTracingRoot: fileURLToPath(new URL("../../", import.meta.url)),
  poweredByHeader: false,
  reactStrictMode: true,
  transpilePackages: ["@shopkit/ui", "@shopkit/sdk"],
  // In production Caddy routes /api and /media to the API. In `next dev` without Caddy, proxy them.
  async rewrites() {
    if (!apiOrigin || process.env.NODE_ENV === "production") return [];
    return [
      { source: "/api/:path*", destination: `${apiOrigin}/api/:path*`, basePath: false },
      { source: "/media/:path*", destination: `${apiOrigin}/media/:path*`, basePath: false },
    ];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "same-origin" },
        ],
      },
    ];
  },
};

export default config;
