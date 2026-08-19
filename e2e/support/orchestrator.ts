/// <reference types="bun-types" />
import { readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { Writable } from "node:stream";
import { createDb } from "@gatecontrol/db";
import { createLogger } from "@gatecontrol/observability";
import { agentRegistry } from "../../apps/orchestrator/src/agent/registry.js";
import type {
  AgentHandle,
  AgentRunner,
  AgentStartOpts,
} from "../../apps/orchestrator/src/agent/runner.js";
import { startWebSocketServer } from "../../apps/orchestrator/src/index.js";
import {
  runTaskLifecycle,
  type StepLike,
  type TaskRunDeps,
} from "../../apps/orchestrator/src/inngest/functions/task-run.js";
import {
  cleanupWorktree,
  commitWorktree,
  diffWorktree,
  discardWorktreeChanges,
  hasChanges,
  provisionWorktree,
} from "../../apps/orchestrator/src/worktree/manager.js";
import { hub } from "../../apps/orchestrator/src/ws/hub.js";
import { PATHS, PORTS } from "./fixture.js";

/**
 * Orchestrator harness for the E2E suite (tasks TASK-025 / TASK-026).
 *
 * It runs the *real* `runTaskLifecycle` and the *real* worktree manager against a deterministic
 * fake agent, and consumes the same `{name, data}` events the web app emits. What it stands in
 * for is only the durable engine: steps run inline and review waits are held in memory, so this
 * process makes no durability claim — that is Inngest's job in a deployment. Everything the
 * tests assert (review gate, worktree isolation, branch on approve) is production code.
 */

/** A Task whose brief carries this marker keeps its agent alive so a test can steer it. */
const STEERABLE = "[steerable]";

/**
 * Deterministic agent: writes a marker into its own worktree and records what it can see there.
 * That recording is the evidence for the isolation test — an agent that could reach another
 * Task's worktree would list the other Task's marker.
 *
 * It also honours input and stop (TASK-022): a steerable Task's run stays open until the
 * operator sends something, and whatever arrives is echoed onto the stream, so a test can follow
 * one instruction all the way from the terminal to the agent and back.
 */
class FixtureAgentRunner implements AgentRunner {
  start(opts: AgentStartOpts): AgentHandle {
    const label = basename(opts.cwd);
    opts.onEvent({ kind: "tool_use", name: "edit_file" });
    writeFileSync(join(opts.cwd, `marker-${label}.txt`), `edited by the agent in ${label}\n`);
    const visible = readdirSync(opts.cwd)
      .filter((f) => f.startsWith("marker-"))
      .sort()
      .join(",");
    writeFileSync(join(opts.cwd, "visible.txt"), `${visible}\n`);
    opts.onEvent({ kind: "stdout", text: `agent edited ${label}\n` });

    if (!opts.prompt.includes(STEERABLE)) {
      return {
        outcome: Promise.resolve({ kind: "completed" }),
        send: async () => false,
        stop: async () => {},
      };
    }

    let finish: () => void = () => {};
    const outcome = new Promise<{ kind: "completed" }>((resolve) => {
      finish = () => resolve({ kind: "completed" });
    });
    return {
      outcome,
      send: async (text: string) => {
        writeFileSync(join(opts.cwd, "steered.txt"), `${text}\n`);
        opts.onEvent({ kind: "stdout", text: `agent received: ${text}\n` });
        finish();
        return true;
      },
      stop: async () => {
        opts.onEvent({ kind: "stdout", text: "agent stopped by the operator\n" });
        finish();
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

function deps(): TaskRunDeps {
  return {
    db: createDb(),
    runner: new FixtureAgentRunner(),
    worktreeRoot: PATHS.worktrees,
    repoCacheRoot: PATHS.repoCache,
    logger: createLogger({ service: "e2e-orchestrator", destination: quietLogs }),
    worktree: {
      provision: provisionWorktree,
      commit: commitWorktree,
      discard: discardWorktreeChanges,
      cleanup: cleanupWorktree,
      hasChanges,
      // The real capture against the real worktree, so the E2E proves the diff a reviewer sees
      // is the diff git reports.
      diff: diffWorktree,
    },
    hub,
    // The same process-wide registry the WebSocket hub looks in, so a frame the SPA sends
    // reaches this run's agent exactly as it would in a deployment.
    registry: agentRegistry,
    agentInvocation: () => ({ command: "fixture-agent", args: [] }),
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
