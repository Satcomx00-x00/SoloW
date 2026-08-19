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
   * The ACP-speaking agent binary and its arguments (TASK-014). Configurable because the
   * adapter that gives Claude Code an ACP interface ships separately from Claude Code itself,
   * and a self-hoster may have it under a different name or path.
   */
  GATECONTROL_AGENT_COMMAND: z.string().min(1).default("claude-code-acp"),
  GATECONTROL_AGENT_ARGS: z
    .string()
    .default("")
    .transform((raw) => raw.split(/\s+/).filter(Boolean)),
});
export type OrchestratorEnv = z.infer<typeof schema>;
let cached: OrchestratorEnv | undefined;
export function orchestratorEnv(): OrchestratorEnv {
  if (cached) return cached;
  cached = schema.parse(process.env);
  return cached;
}
