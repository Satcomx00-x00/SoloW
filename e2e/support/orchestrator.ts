/// <reference types="bun-types" />
import { readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { Writable } from "node:stream";
import { createDb } from "@solow/db";
import { createLogger } from "@solow/observability";
import { $ } from "bun";
import { createLocalExecutor } from "../../apps/orchestrator/src/executor/local.js";
import { harnessRegistry } from "../../apps/orchestrator/src/harness/registry.js";
import type {
  HarnessHandle,
  HarnessOutcome,
  HarnessRunner,
  HarnessStartOpts,
} from "../../apps/orchestrator/src/harness/runner.js";
import { startWebSocketServer } from "../../apps/orchestrator/src/index.js";
import {
  runTaskLifecycle,
  type StepLike,
  type TaskRunDeps,
} from "../../apps/orchestrator/src/inngest/functions/task-run.js";
import {
  adoptWorktree,
  cleanupWorktree,
  commitWorktree,
  diffWorktree,
  discardWorktreeChanges,
  hasChanges,
  prepareRepository,
  provisionWorktree,
  publishWorktreeBranch,
} from "../../apps/orchestrator/src/worktree/manager.js";
import { seedSetupFiles } from "../../apps/orchestrator/src/worktree/setup-files.js";
import { hub } from "../../apps/orchestrator/src/ws/hub.js";
import { PATHS, PORTS } from "./fixture.js";

/**
 * Orchestrator harness for the E2E suite (tasks TASK-025 / TASK-026).
 *
 * It runs the *real* `runTaskLifecycle` and the *real* worktree manager against a deterministic
 * fake harness, and consumes the same `{name, data}` events the web app emits. What it stands in
 * for is only the durable engine: steps run inline and review waits are held in memory, so this
 * process makes no durability claim — that is Inngest's job in a deployment. Everything the
 * tests assert (review gate, worktree isolation, branch on approve) is production code.
 */

/** A Task whose brief carries this marker keeps its harness alive so a test can steer it. */
const STEERABLE = "[steerable]";

/**
 * Markers a Step's prompt can carry to script what the fixture harness *reports* — the two
 * things a Workflow condition reads (`@solow/core`'s `conditionHolds`), sent the way a real
 * harness sends them: a `task_complete` widget fenced in its output.
 *
 *   [outcome:blocked]      report that outcome (`changes_ready`, `nothing_to_do`, `blocked`)
 *   [decide:yes]           answer the Step's branch question with yes (or no)
 *   [decide:yes x2]        yes the first two times this Task reaches this Step, then no —
 *                          a loop that ends, which is what a backward branch needs to be tested
 *
 * The count is per Task and per marker, in memory: the orchestrator process outlives the run,
 * and a file in the worktree would show up in the diff a reviewer is asked to read.
 */
const DECIDE = /\[decide:(yes|no)(?:\s+x(\d+))?\]/;
const OUTCOME = /\[outcome:(changes_ready|nothing_to_do|blocked)\]/;
const decisionsGiven = new Map<string, number>();

/** The widget a scripted prompt asks for, or null when the prompt scripts nothing. */
function scriptedReport(
  prompt: string,
  taskLabel: string,
): { outcome: string; decision?: "yes" | "no"; summary: string } | null {
  const decide = DECIDE.exec(prompt);
  const outcome = OUTCOME.exec(prompt);
  if (!decide && !outcome) return null;
  const report: { outcome: string; decision?: "yes" | "no"; summary: string } = {
    outcome: outcome?.[1] ?? "changes_ready",
    summary: `fixture harness report for ${taskLabel}`,
  };
  if (decide) {
    const key = `${taskLabel}|${decide[0]}`;
    const given = decisionsGiven.get(key) ?? 0;
    decisionsGiven.set(key, given + 1);
    const times = decide[2] === undefined ? Number.POSITIVE_INFINITY : Number(decide[2]);
    const scripted = decide[1] === "yes" ? "yes" : "no";
    const other = scripted === "yes" ? "no" : "yes";
    report.decision = given < times ? scripted : other;
    report.summary += ` — DECISION: ${report.decision}`;
  }
  return report;
}

/**
 * Deterministic harness standing in for Claude Code.
 *
 * It does what `claude --worktree` does: creates its own git worktree off the repository it was
 * pointed at, works only in there, and reports the path back so SoloW can adopt it. That
 * is what makes the isolation test meaningful under the new model — the harness, not SoloW,
 * chooses the directory, and the guarantee is that two harnesses on one repository never share one.
 *
 * It writes a marker into its worktree and records what it can see there. That recording is the
 * evidence: a harness that could reach another Task's worktree would list the other's marker.
 *
 * It also honours input and stop (TASK-022): a steerable Task's run stays open until the
 * operator sends something, and whatever arrives is echoed onto the stream.
 */
class FixtureHarnessRunner implements HarnessRunner {
  start(opts: HarnessStartOpts): HarnessHandle {
    // A resume round passes no name: the worktree already exists and `cwd` points at it
    // (see HarnessStartOpts.worktreeName). Only a first round creates one.
    const worktree = opts.worktreeName ? join(PATHS.worktrees, opts.worktreeName) : opts.cwd;

    let resolveWorkspace: (path: string | null) => void = () => {};
    const workspacePath = new Promise<string | null>((resolve) => {
      resolveWorkspace = resolve;
    });

    let finish: (outcome: HarnessOutcome) => void = () => {};
    const outcome = new Promise<HarnessOutcome>((resolve) => {
      finish = resolve;
    });

    void (async () => {
      // The harness creates its own worktree, exactly as `claude --worktree <name>` would —
      // but only on a first round. Asking git to add it again would fail, or branch a fresh
      // one from the base ref and throw the earlier round's work away.
      if (opts.worktreeName) {
        await $`git -C ${opts.cwd} worktree add -b ${opts.worktreeName} ${worktree}`.quiet();
      }
      resolveWorkspace(worktree);

      const label = basename(worktree);
      opts.onEvent({
        kind: "tool_use",
        name: "edit_file",
        callId: null,
        input: undefined,
        status: null,
      });
      writeFileSync(join(worktree, `marker-${label}.txt`), `edited by the harness in ${label}\n`);
      const visible = readdirSync(worktree)
        .filter((f) => f.startsWith("marker-"))
        .sort()
        .join(",");
      writeFileSync(join(worktree, "visible.txt"), `${visible}\n`);
      opts.onEvent({ kind: "stdout", channel: "assistant", text: `harness edited ${label}\n` });

      // A scripted Step reports through the same fenced widget Claude Code emits, so the run
      // loop's own scanner, the completion record and the branch evaluation all run for real.
      const report = scriptedReport(opts.prompt, label);
      if (report) {
        const widget = JSON.stringify({ kind: "task_complete", ...report });
        opts.onEvent({
          kind: "stdout",
          channel: "assistant",
          text: `\`\`\`solow:widget\n${widget}\n\`\`\`\n`,
        });
      }

      if (!opts.prompt.includes(STEERABLE)) finish({ kind: "completed", stopReason: "end_turn" });
    })();

    return {
      outcome,
      workspacePath,
      // A fake with no conversation store behind it — nothing to resume.
      harnessSessionId: Promise.resolve(null),
      send: async (text: string) => {
        const path = await workspacePath;
        if (!path) return false;
        writeFileSync(join(path, "steered.txt"), `${text}\n`);
        opts.onEvent({ kind: "stdout", channel: "user", text: `harness received: ${text}\n` });
        finish({ kind: "completed", stopReason: "end_turn" });
        return true;
      },
      stop: async () => {
        opts.onEvent({
          kind: "stdout",
          channel: "system",
          text: "harness stopped by the operator\n",
        });
        finish({ kind: "completed", stopReason: "cancelled" });
      },
    };
  }
}

/** Review waits, keyed by session id — released when `review.decided` arrives. */
const waiters = new Map<string, (data: unknown) => void>();

/** Inline step tools: no memoization, no durability — see the file header. */
function localStep(sessionId: string): StepLike {
  return {
    run: async (_id, fn) => fn(),
    waitForEvent: (_id, _opts) =>
      new Promise((resolve) => {
        waiters.set(sessionId, (data) => resolve({ data }));
      }),
    // Parking would otherwise stall the suite for hours; the park path itself is covered by the
    // orchestrator integration tests (TASK-020).
    sleepUntil: async () => {},
  };
}

const quietLogs = new Writable({
  write(_chunk, _enc, cb) {
    cb();
  },
});

// The real local Executor (issue #1) — the E2E suite proves the lifecycle against the same
// git-through-executor path production uses, not a harness shortcut.
const executor = createLocalExecutor(PATHS.worktrees);

function deps(): TaskRunDeps {
  return {
    db: createDb(),
    // One fixture runner whatever the catalog row's protocol says: the E2E proves the lifecycle,
    // not the protocol, and `packages/acp` covers that against a scripted peer (issue #58).
    runner: () => new FixtureHarnessRunner(),
    /*
     * The fixture's own executor, not `createExecutorFor` (issue #96): the suite pins its roots
     * to `PATHS`, while the factory reads the deployment's environment, and a fixture that ran
     * against `.solow/worktrees` would be proving the lifecycle somewhere else entirely. Every
     * profile the suite seeds is local, so there is nothing for a preflight to ask a daemon.
     */
    executorFor: () => executor,
    preflight: async () => ({ ok: true, harnessCommands: [] }),
    worktreeRoot: PATHS.worktrees,
    repoCacheRoot: PATHS.repoCache,
    logger: createLogger({ service: "e2e-orchestrator", destination: quietLogs }),
    worktree: () => ({
      prepare: (params) => prepareRepository(executor, params),
      provision: (params) => provisionWorktree(executor, params),
      adopt: (repoPath, reportedPath) => adoptWorktree(executor, repoPath, reportedPath),
      seed: (params) => seedSetupFiles(executor, params),
      commit: (path, message, patterns) => commitWorktree(executor, path, message, patterns),
      discard: (path) => discardWorktreeChanges(executor, path),
      // Every profile the suite seeds is local, so the Task works directly in the shared
      // repository and this is the no-op branch of `publishWorktreeBranch` — wired anyway
      // rather than stubbed, so a future containerised fixture publishes for real.
      publish: (repoPath, upstreamPath, branch) =>
        publishWorktreeBranch(executor, repoPath, upstreamPath, branch),
      cleanup: (repoPath, worktree) => cleanupWorktree(executor, repoPath, worktree),
      hasChanges: (path, patterns) => hasChanges(executor, path, patterns),
      // The real capture against the real worktree, so the E2E proves the diff a reviewer sees
      // is the diff git reports.
      diff: (path, patterns) => diffWorktree(executor, path, patterns),
    }),
    hub,
    // The same process-wide registry the WebSocket hub looks in, so a frame the SPA sends
    // reaches this run's harness exactly as it would in a deployment.
    registry: harnessRegistry,
  };
}

const inFlight = new Set<Promise<unknown>>();

function handleEvent(name: string, data: Record<string, unknown>): void {
  if (name === "task.launch.requested") {
    const sessionId = String(data["sessionId"]);
    const run = runTaskLifecycle(deps(), { event: { data }, step: localStep(sessionId) })
      .catch((cause) => console.error("[e2e-orchestrator] lifecycle failed:", cause))
      .finally(() => inFlight.delete(run));
    inFlight.add(run);
    return;
  }
  if (name === "review.decided") {
    const sessionId = String(data["sessionId"]);
    waiters.get(sessionId)?.(data);
    waiters.delete(sessionId);
  }
}

startWebSocketServer(PORTS.ws);

Bun.serve({
  port: PORTS.orchestrator,
  async fetch(req) {
    const { pathname } = new URL(req.url);
    if (pathname === "/health") return new Response("ok");
    if (pathname === "/events" && req.method === "POST") {
      const body = (await req.json()) as { name: string; data: Record<string, unknown> };
      handleEvent(body.name, body.data);
      return new Response(null, { status: 202 });
    }
    return new Response("not found", { status: 404 });
  },
});

console.log(`[e2e-orchestrator] events :${PORTS.orchestrator} · ws :${PORTS.ws}`);
