import { z } from "zod";

/** Validated orchestrator env (no bare process.env). */
const schema = z.object({
  GATECONTROL_WS_PORT: z.coerce.number().int().default(5001),
  GATECONTROL_WORKTREE_ROOT: z.string().min(1).default(".gatecontrol/worktrees"),
  GATECONTROL_REPO_CACHE_ROOT: z.string().min(1).default(".gatecontrol/repos"),
});
export type OrchestratorEnv = z.infer<typeof schema>;
let cached: OrchestratorEnv | undefined;
export function orchestratorEnv(): OrchestratorEnv {
  if (cached) return cached;
  cached = schema.parse(process.env);
  return cached;
}
