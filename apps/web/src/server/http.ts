import "server-only";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { createContext } from "./context.js";
import { appRouter } from "./routers/index.js";

/**
 * Framework-agnostic fetch handler for the tRPC API (Decision 0011). The Next.js Route
 * Handler (`app/api/trpc/[trpc]/route.ts`, added with the SPA in Phase 4) is a thin
 * wrapper that delegates here.
 */
export function handleTrpcRequest(req: Request): Promise<Response> {
  return fetchRequestHandler({
    endpoint: "/api/trpc",
    req,
    router: appRouter,
    createContext: () => createContext({ req }),
  });
}
