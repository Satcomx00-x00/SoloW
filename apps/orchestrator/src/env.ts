import { z } from "zod";

/** Validated orchestrator env (no bare process.env). */
const schema = z.object({
  GATECONTROL_WS_PORT: z.coerce.number().int().default(5001),
  GATECONTROL_WORKTREE_ROOT: z.string().min(1).default(".gatecontrol/worktrees"),
  GATECONTROL_REPO_CACHE_ROOT: z.string().min(1).default(".gatecontrol/repos"),
  /**
   * HMAC key for stream subscription tickets (TASK-018) — the same value the web app signs
   * with. Required: without it the hub could not authenticate a subscriber at all.
   */
  GATECONTROL_STREAM_SECRET: z.string().min(1),
  /**
   * What an ACP permission nobody answered decays to (issue #58, AC-4). Refusal unless a
   * deployment names the permissive posture — a deployment can widen its own posture on
   * purpose, and none can widen it by leaving this unset. See `agent/permissions.ts`.
   */
  GATECONTROL_ACP_UNATTENDED_PERMISSION: z.enum(["refuse", "allow_once"]).default("refuse"),
});
export type OrchestratorEnv = z.infer<typeof schema>;
let cached: OrchestratorEnv | undefined;
export function orchestratorEnv(): OrchestratorEnv {
  if (cached) return cached;
  cached = schema.parse(process.env);
  return cached;
}
