import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // `npx solow` ships a prebuilt web app, and standalone is what makes that shippable: Next
  // traces the server's real imports and copies just those into `.next/standalone`, turning a
  // 1.1 GB build directory into a few megabytes that run without the monorepo around them.
  // Gated on the packaging flag so `bun run dev` and `bun run start` keep the ordinary build
  // they have always had — standalone's server.js ignores `next start`'s flags, so making it
  // unconditional would quietly change how the local stack boots.
  ...(process.env.SOLOW_PACKAGE_BUILD === "1"
    ? {
        output: "standalone",
        // Without this Next roots the trace at `apps/web` and leaves every hoisted dependency
        // (they live in the monorepo root's node_modules) out of the standalone tree.
        outputFileTracingRoot: join(dirname(fileURLToPath(import.meta.url)), "..", ".."),
      }
    : {}),
  // Types and lint are enforced by `bun run typecheck` (tsc) and Biome; skip Next's duplicate
  // build-time passes (they use a separate resolver that conflicts with the bun-types setup).
  typescript: { ignoreBuildErrors: true },
  eslint: { ignoreDuringBuilds: true },
  // The DB package uses Bun's built-in `bun:sqlite`; keep it as a runtime import (not bundled)
  // so the webpack build never tries to resolve the `bun:` builtin. The app runs under the Bun
  // runtime (`bun --bun next …`), where the import resolves natively (Decision 0008).
  serverExternalPackages: ["@solow/db"],
  // Workspace TS packages consumed as source need transpiling by Next.
  transpilePackages: ["@solow/core", "@solow/contracts", "@solow/observability"],
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
