import { z } from "zod";

/**
 * Validated environment module for the web/API app (constitution Security constraint).
 * No other module in apps/web reads process.env directly.
 *
 * Credential-isolation note (finding C1, carried as a documented v1 limitation): the web
 * layer never reads agent credentials. Agent credentials are decrypted only in the
 * orchestrator and injected into a single agent process's env — the web env never
 * contains them.
 */
const webEnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  /**
   * BetterAuth session secret. At least 32 characters: it signs the session cookie, so a short
   * or guessable value means forged sessions — refuse to boot rather than warn.
   * Generate one with `openssl rand -base64 32`.
   */
  SOLOW_AUTH_SECRET: z.string().min(32),
  /** Base URL the SPA is served from. */
  SOLOW_WEB_URL: z.string().url().default("http://localhost:5000"),
  /** WebSocket endpoint exposed by the orchestrator service. */
  SOLOW_WS_URL: z.string().url().default("ws://localhost:5001"),
  /**
   * HMAC key for stream subscription tickets (TASK-018). Shared with the orchestrator, which
   * verifies what this app signs. Required — an unset key would mean unauthenticated streams.
   */
  SOLOW_STREAM_SECRET: z.string().min(1),
});

export type WebEnv = z.infer<typeof webEnvSchema>;

let cached: WebEnv | undefined;

export function webEnv(): WebEnv {
  if (cached) return cached;
  cached = webEnvSchema.parse(process.env);
  return cached;
}

/**
 * Local single-user dev mode. When `SOLOW_DEV_OWNER=on`, the API resolves a fixed local
 * Owner bound to the seeded Workspace and enables `ff-core-program` — a stand-in for BetterAuth
 * so the SPA slice can read live data before auth is wired. Never enable in production.
 * Parsed separately so it does not require the full (auth-secret-bearing) web env.
 */
const devEnvSchema = z.object({
  SOLOW_DEV_OWNER: z.enum(["on", "off"]).default("off"),
});

export function devOwnerMode(): boolean {
  return devEnvSchema.parse(process.env).SOLOW_DEV_OWNER === "on";
}

/**
 * Base URL of the workflow-event consumer (the orchestrator service, or Inngest when hosted).
 * `undefined` means no engine is wired — see `orchestrator-client`. Parsed separately for the
 * same reason as the dev flag: it must be readable without the full web env.
 */
const orchestratorEnvSchema = z.object({
  SOLOW_ORCHESTRATOR_URL: z.string().url().optional(),
});

export function orchestratorUrl(): string | undefined {
  return orchestratorEnvSchema.parse(process.env).SOLOW_ORCHESTRATOR_URL;
}
