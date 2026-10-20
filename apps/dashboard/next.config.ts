import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Every page is per-admin and must show live data, so Cache Components (static
  // shells, `use cache`) would add caching decisions with nothing to gain here.
  // Without it, any page that reads the session cookie renders per request.
  cacheComponents: false,
  // The shared packages are TypeScript source (no build step), like in the Worker.
  transpilePackages: ["@zeropoint/crypto", "@zeropoint/pricing", "@zeropoint/schemas", "@zeropoint/types"],
  poweredByHeader: false,
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
