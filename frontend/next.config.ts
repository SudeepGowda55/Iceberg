import type { NextConfig } from "next";

// hosted builds serve the recorded fork snapshot (lib/snapshot.ts): ship data/ with the API functions
const nextConfig: NextConfig = { outputFileTracingIncludes: { "/api/**/*": ["./data/**/*"] } };

export default nextConfig;
