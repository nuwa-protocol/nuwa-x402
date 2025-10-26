import type { NextConfig } from "next";

if (!process.env.CI) {
  // Ensure env schema runs during local dev
  require("./src/lib/env");
}

const nextConfig: NextConfig = {
  // Transpile the local workspace package so we can publish TS sources
  transpilePackages: ["@nuwa-ai/x402"],
  typescript: { ignoreBuildErrors: true },
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
