import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // Keep Proxy buffering aligned with the generation route's 196-MiB guard.
    proxyClientMaxBodySize: 196 * 1024 * 1024,
  },
};

export default nextConfig;
