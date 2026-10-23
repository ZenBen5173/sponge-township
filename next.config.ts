import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  // the film can be pulled straight into an uploader or embed on another site
  async headers() {
    return [{ source: "/film/:file*", headers: [{ key: "Access-Control-Allow-Origin", value: "*" }] }];
  },
  partialPrefetching: true,
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
