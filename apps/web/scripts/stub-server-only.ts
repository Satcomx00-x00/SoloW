import { plugin } from "bun";

/**
 * Preload for build scripts that import the tRPC routers outside a React Server Component.
 * The routers begin with `import "server-only"`, whose module throws by design when loaded
 * anywhere but an RSC. For a Node/Bun build step (OpenAPI generation) we resolve it to an
 * empty module so the router graph can be imported for introspection only.
 */
plugin({
  name: "stub-server-only",
  setup(build) {
    build.module("server-only", () => ({ exports: {}, loader: "object" }));
  },
});
