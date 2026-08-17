import { generateOpenApiDocument, type OpenAPIObject } from "trpc-to-openapi";
import { appRouter } from "./server/routers/index.js";

/**
 * OpenAPI 3.1 document generated from the tRPC routers (task TASK-013 / Decision 0011).
 * The Zod contracts are the single source of truth — this export keeps an HTTP-shaped
 * description of every flagged procedure. Committed as a build artifact via
 * `scripts/gen-openapi.ts`; CI fails if it drifts from the routers.
 */
export function buildOpenApiDocument(): OpenAPIObject {
  return generateOpenApiDocument(appRouter, {
    title: "GateControl API",
    version: "0.1.0",
    baseUrl: "/api",
    description: "tRPC-over-HTTP surface for the core-program loop (Decision 0011).",
    securitySchemes: {
      session: { type: "apiKey", in: "cookie", name: "gatecontrol.session" },
    },
  });
}
