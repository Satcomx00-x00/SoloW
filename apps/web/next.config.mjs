import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  /**
   * Where the build output goes, overridable so two Next servers can share this checkout.
   *
   * The E2E suite starts its own `next dev` in this directory while `scripts/start.sh` may be
   * serving a production build from the same one, and they both default to `.next`. The dev
   * server wins, silently: it replaces the built output with development chunks, `BUILD_ID`
   * empties, and the running production server answers **400 on every static asset** while still
   * serving HTML — a blank app with no error anywhere that names the cause. Diagnosed exactly
   * that way, from a browser console full of chunk 404s.
   *
   * Left at `.next` for every ordinary build; the suite sets this to a directory of its own.
   */
  distDir: process.env.SOLOW_NEXT_DIST_DIR ?? ".next",
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
  /**
   * Compile in a worker, and let the server/edge compiles and the build-trace collection overlap.
   *
   * Next turns the build worker *off* whenever a `webpack` function is configured (below), and
   * the two `parallel*` options refuse to run without it — so with this project's config the
   * build was silent on both, and ran the compile, the page-data pass and the trace collection
   * one after another on under two of eight cores. Measured on this machine, cache warm: 52 s
   * without, 40 s with. The first build after changing this file is slower than either, because
   * a config change invalidates the webpack cache — that is the change, not the flags.
   */
  experimental: {
    webpackBuildWorker: true,
    parallelServerCompiles: true,
    parallelServerBuildTraces: true,
  },
  // The DB package uses Bun's built-in `bun:sqlite`; keep it as a runtime import (not bundled)
  // so the webpack build never tries to resolve the `bun:` builtin. The app runs under the Bun
  // runtime (`bun --bun next …`), where the import resolves natively (Decision 0008) — and so
  // does the *build*: collecting page data imports the server code, so `next build` under Node
  // fails on `/sign-in` with "Cannot find module 'bun:sqlite'". That is why package.json's
  // `build`/`start`/`dev` scripts say `bun --bun next …` themselves rather than relying on the
  // caller to: Turborepo runs them as `bun run <script>`, which would otherwise hand them to Node.
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
