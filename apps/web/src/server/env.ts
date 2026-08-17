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
  /** BetterAuth session secret. */
  GATECONTROL_AUTH_SECRET: z.string().min(1),
  /** Base URL the SPA is served from. */
  GATECONTROL_WEB_URL: z.string().url().default("http://localhost:3000"),
  /** WebSocket endpoint exposed by the orchestrator service. */
  GATECONTROL_WS_URL: z.string().url().default("ws://localhost:3001"),
});

export type WebEnv = z.infer<typeof webEnvSchema>;

let cached: WebEnv | undefined;

export function webEnv(): WebEnv {
  if (cached) return cached;
  cached = webEnvSchema.parse(process.env);
  return cached;
}
