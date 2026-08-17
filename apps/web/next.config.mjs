/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Types and lint are enforced by `bun run typecheck` (tsc) and Biome; skip Next's duplicate
  // build-time passes (they use a separate resolver that conflicts with the bun-types setup).
  typescript: { ignoreBuildErrors: true },
  eslint: { ignoreDuringBuilds: true },
  // The DB package uses Bun's built-in `bun:sqlite`; keep it as a runtime import (not bundled)
  // so the webpack build never tries to resolve the `bun:` builtin. The app runs under the Bun
  // runtime (`bun --bun next …`), where the import resolves natively (Decision 0008).
  serverExternalPackages: ["@gatecontrol/db"],
  // Workspace TS packages consumed as source need transpiling by Next.
  transpilePackages: ["@gatecontrol/core", "@gatecontrol/contracts", "@gatecontrol/observability"],
  webpack: (config) => {
    config.externals = config.externals ?? [];
    config.externals.push({ "bun:sqlite": "commonjs bun:sqlite" });
    // The server code uses NodeNext-style `.js` import specifiers that actually point at `.ts`
    // sources; teach webpack to resolve them (tsc/Bun already do).
    config.resolve = config.resolve ?? {};
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      ".js": [".ts", ".tsx", ".js"],
      ".jsx": [".tsx", ".jsx"],
    };
    return config;
  },
};

export default nextConfig;
