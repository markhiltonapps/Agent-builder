import type { NextConfig } from "next";

// Every page here is per-user and needs the session, so there is nothing to prerender:
// Cache Components stays off.
const nextConfig: NextConfig = {
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
