import { z } from "zod";

/** Validated orchestrator env (no bare process.env). */
const schema = z.object({
  SOLOW_WS_PORT: z.coerce.number().int().default(5001),
  SOLOW_WORKTREE_ROOT: z.string().min(1).default(".solow/worktrees"),
  SOLOW_REPO_CACHE_ROOT: z.string().min(1).default(".solow/repos"),
  /**
   * HMAC key for stream subscription tickets (TASK-018) — the same value the web app signs
   * with. Required: without it the hub could not authenticate a subscriber at all.
   */
  SOLOW_STREAM_SECRET: z.string().min(1),
  /**
   * What an ACP permission nobody answered decays to (issue #58, AC-4). Refusal unless a
   * deployment names the permissive posture — a deployment can widen its own posture on
   * purpose, and none can widen it by leaving this unset. See `agent/permissions.ts`.
   */
  SOLOW_ACP_UNATTENDED_PERMISSION: z.enum(["refuse", "allow_once"]).default("refuse"),
  /**
   * The Docker CLI the container executor invokes (issue #96). Named here rather than hardcoded
   * in the driver because the driver reaches the daemon by composing argv for a host `Executor`:
   * a machine whose client is a wrapper script, or lives outside the service PATH, is then a
   * deployment setting instead of a fork of the driver.
   */
  SOLOW_DOCKER_BIN: z.string().min(1).default("docker"),
  /**
   * How long the preflight lets `docker pull` run before giving up. Ten minutes because a cold
   * pull of a multi-gigabyte agent image over a domestic link genuinely takes minutes, and a
   * shorter ceiling would turn a slow network into a failed Task with an image the operator can
   * see is fine. Exceeding it is raised as an ordinary error — Inngest retries it — never as
   * "this executor is unavailable".
   */
  SOLOW_DOCKER_PULL_TIMEOUT_MS: z.coerce.number().int().positive().default(600_000),
  /**
   * `uid:gid` for the processes inside the container, overriding the orchestrator's own
   * `getuid()`/`getgid()`. Numeric on purpose: a username would be resolved against the
   * *image's* `/etc/passwd`, while the entire reason the flag is passed is that files the agent
   * writes into the bind-mounted worktree must land owned by a uid the host can later remove —
   * root-owned files there make `git worktree remove --force` fail and leak the worktree after
   * the Task is already marked done.
   */
  SOLOW_DOCKER_USER: z
    .string()
    .regex(/^\d+:\d+$/, "SOLOW_DOCKER_USER must be a numeric uid:gid pair, e.g. 1000:1000")
    .optional(),
});
export type OrchestratorEnv = z.infer<typeof schema>;
let cached: OrchestratorEnv | undefined;
export function orchestratorEnv(): OrchestratorEnv {
  if (cached) return cached;
  cached = schema.parse(process.env);
  return cached;
}
