/// <reference types="bun-types" />
import { readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { Writable } from "node:stream";
import { harnessExplainRequest, taskPurgeRequestedData } from "@solow/contracts";
import { verifyStreamTicket } from "@solow/core/stream";
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
  HarnessStreamEvent,
} from "../../apps/orchestrator/src/harness/runner.js";
import { startWebSocketServer } from "../../apps/orchestrator/src/index.js";
import {
  runTaskLifecycle,
  type StepLike,
  type TaskRunDeps,
} from "../../apps/orchestrator/src/inngest/functions/task-run.js";
import { removeTaskFiles } from "../../apps/orchestrator/src/retention.js";
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
import { PATHS, PORTS, SCRIPTED_LINKS } from "./fixture.js";

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
 * A Task whose brief carries this marker has its harness *ship* the work: push the branch, open
 * a merge request, and read the pipeline back — through the shell, as a real one does.
 *
 * Scripted here rather than faked at the API, because the thing under test is that SoloW reads
 * those actions back out of its own log (F10 FR-12a). The run loop persists these as ordinary
 * tool rows, through the same argument allowlist and the same truncation a real harness's calls
 * go through, so the link list the Task page draws is derived from the log a real run leaves —
 * not from a shape invented for the test.
 */
const OPENS_MR = "[opens-mr]";

/**
 * The shell the marker scripts, command by command, with the output each one really prints.
 *
 * The push comes first and matters most: GitLab answers every push to a branch with no merge
 * request behind it by *offering* to open one, and that offer is a URL under `/merge_requests/`
 * like any other. A reader that took it would report a merge request nobody opened, on every
 * run. It is here so a test can assert the button is absent.
 */
function shipTheWork(onEvent: (e: HarnessStreamEvent) => void, branch: string): void {
  const ran = (callId: string, command: string, output: string) => {
    onEvent({ kind: "tool_use", name: "Bash", callId, input: { command }, status: "completed" });
    onEvent({ kind: "tool_result", callId, ok: true, output });
  };
  ran(
    "ship-push",
    `git push -u origin ${branch}`,
    [
      "remote:",
      "remote: To create a merge request for this branch, visit:",
      `remote:   ${SCRIPTED_LINKS.offer}`,
      "remote:",
      `To gitlab.example.test:acme/gate.git`,
      ` * [new branch]      ${branch} -> ${branch}`,
    ].join("\n"),
  );
  ran(
    "ship-mr",
    "glab mr create --fill --yes",
    [`Creating merge request for ${branch} into main`, "!42", SCRIPTED_LINKS.mergeRequest].join(
      "\n",
    ),
  );
  ran(
    "ship-ci",
    "glab ci status --live=false",
    ["Pipeline state: running", `${SCRIPTED_LINKS.pipeline}`].join("\n"),
  );
}

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
      // The launch as the harness received it — which `HOME` it was pointed at (Decision 0027)
      // and what its brief said (a sub-task's carries its parent's transcript, issue #56).
      writeFileSync(
        join(PATHS.harnessRuns, `${label}.json`),
        JSON.stringify({
          home: opts.env["HOME"] ?? null,
          claudeConfigDir: opts.env["CLAUDE_CONFIG_DIR"] ?? null,
          xdgConfigHome: opts.env["XDG_CONFIG_HOME"] ?? null,
          prompt: opts.prompt,
        }),
      );
      opts.onEvent({ kind: "stdout", channel: "assistant", text: `harness edited ${label}\n` });

      // A harness that ships what it wrote: the shell calls a real one makes once the edit is
      // done, and the URLs their output carries.
      if (opts.prompt.includes(OPENS_MR)) shipTheWork(opts.onEvent, label);

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

/**
 * Inline step tools: no memoization, no durability — see the file header. A review gate needs
 * nothing here: a run ends at it, and the decision arrives as another `task.launch.requested`.
 */
function localStep(): StepLike {
  return {
    run: async (_id, fn) => fn(),
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
    const run = runTaskLifecycle(deps(), { event: { data }, step: localStep() })
      .catch((cause) => console.error("[e2e-orchestrator] lifecycle failed:", cause))
      .finally(() => inFlight.delete(run));
    inFlight.add(run);
    return;
  }
  if (name === "task.purge.requested") {
    // The rows are gone; the paths the event carries are what is left to remove — the same
    // removal the real orchestrator's `task-purge` function runs.
    const purge = taskPurgeRequestedData.parse(data);
    const run = removeTaskFiles(executor, PATHS.worktrees, purge.taskId, purge.worktrees, (m, c) =>
      console.error(`[e2e-orchestrator] ${m}`, c ?? ""),
    )
      .catch((cause) => console.error("[e2e-orchestrator] purge failed:", cause))
      .finally(() => inFlight.delete(run));
    inFlight.add(run);
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
    if (pathname === "/explain" && req.method === "POST") return handleExplain(req);
    return new Response("not found", { status: 404 });
  },
});

console.log(`[e2e-orchestrator] events :${PORTS.orchestrator} · ws :${PORTS.ws}`);

/**
 * `POST /explain` — the Brief tab's Explain, answered by the fixture harness (the real
 * orchestrator drives one print turn of the Task's harness; see `harness/explain.ts` there).
 * The contract is the real one — the same ticket, verified the same way, scoped to the Task —
 * and the answer is scripted from the prompt, so a spec can assert the text landed where the
 * criterion is without a model in the loop.
 */
async function handleExplain(req: Request): Promise<Response> {
  const parsed = harnessExplainRequest.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return new Response("invalid_request", { status: 400 });
  const verified = verifyStreamTicket(
    parsed.data.ticket,
    process.env.SOLOW_STREAM_SECRET ?? "",
    Date.now(),
  );
  if (!verified.ok) return new Response(verified.error, { status: 401 });
  if (verified.claims.taskId !== parsed.data.taskId) {
    return new Response("ticket_task_mismatch", { status: 403 });
  }
  const criterion = /# Criterion (\S+)/.exec(parsed.data.prompt)?.[1] ?? "the criterion";
  const language = /Reader's language: (\S+)/.exec(parsed.data.prompt)?.[1] ?? "en";
  return Response.json({
    ok: true,
    text: `**What it means** — the fixture harness explains ${criterion} in plain words, in ${language}.`,
    model: "fixture-harness",
    reason: null,
    failure: null,
  });
}
