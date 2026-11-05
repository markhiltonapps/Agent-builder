import type { NextConfig } from "next";

// Every page here is per-user and needs the session, so there is nothing to prerender:
// Cache Components stays off.
const nextConfig: NextConfig = {
  // Knowledge files can be up to 2 MB, and the page sends each one to the server as it is.
  experimental: { serverActions: { bodySizeLimit: "3mb" } },
  // Nobody may frame the signed-in app (clickjacking). Only /embed/* can be framed, and the
  // proxy sets which sites may do it, per agent.
  async headers() {
    return [
      {
        source: "/((?!embed/|embed\\.js).*)",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
        ],
      },
    ];
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
