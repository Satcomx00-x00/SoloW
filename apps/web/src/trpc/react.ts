import { createTRPCReact } from "@trpc/react-query";
import type { AppRouter } from "@/server/routers";

/**
 * Typed tRPC React hooks for the SPA (Decision 0013). `AppRouter` is a type-only import, so
 * the server router graph (which begins with `import "server-only"`) never enters the client
 * bundle — only its types do.
 */
export const trpc = createTRPCReact<AppRouter>();
