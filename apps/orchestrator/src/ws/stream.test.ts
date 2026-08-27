/// <reference types="bun-types" />

import { beforeEach, describe, expect, it } from "bun:test";
import type { TaskEvent } from "@solow/contracts";
import { signStreamTicket } from "@solow/core/stream";
import {
  agentCatalog,
  agentProfile,
  executorProfile,
  issue,
  repository,
  session,
  sessionEvent,
  task,
  taskRepository,
  workspace,
} from "@solow/db";
import { createTestDb, type TestDb } from "@solow/db/testing";
import { AgentRegistry } from "../agent/registry.js";
import type { AgentHandle, PermissionAnswer } from "../agent/runner.js";
import { attachSubscriber, authorizeUpgrade, handleClientFrame } from "../index.js";
import { hub } from "./hub.js";

/**
 * WebSocket connection auth + reconnect replay (task TASK-018). Covers the two acceptance
 * criteria: a client can subscribe only to its own Workspace's channel (Principle V), and on
 * reconnect the events it missed are replayed from the session log.
 */

const SECRET = "orchestrator-stream-test-secret";
const NOW = 1_700_000_000_000;
const deps = { now: () => NOW, streamSecret: SECRET };

const url = (params: Record<string, string>) =>
  `http://hub.local/?${new URLSearchParams(params).toString()}`;

describe("authorizeUpgrade", () => {
  it("derives the channel from the ticket's own claims, not from the query string", () => {
    const ticket = signStreamTicket({ workspaceId: "ws-a", taskId: "task-1" }, SECRET, NOW);
    // The client also asks for another Workspace's channel — it must be ignored entirely.
    const res = authorizeUpgrade(url({ ticket, channel: "ws:ws-b:task:task-9" }), deps);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.channel).toBe("ws:ws-a:task:task-1");
    expect(res.data.claims.workspaceId).toBe("ws-a");
  });

  it("refuses a connection with no ticket", () => {
    expect(authorizeUpgrade(url({}), deps)).toEqual({
      ok: false,
      status: 401,
      error: "ticket_required",
    });
  });

  it("refuses a ticket signed with a different secret", () => {
    const forged = signStreamTicket({ workspaceId: "ws-b", taskId: null }, "not-the-secret", NOW);
    const res = authorizeUpgrade(url({ ticket: forged }), deps);
    expect(res).toEqual({ ok: false, status: 401, error: "ticket_signature_invalid" });
  });

  it("refuses an expired ticket", () => {
    const stale = signStreamTicket({ workspaceId: "ws-a", taskId: null }, SECRET, NOW - 120_000);
    const res = authorizeUpgrade(url({ ticket: stale }), deps);
    expect(res).toEqual({ ok: false, status: 401, error: "ticket_expired" });
  });

  it("reads the replay cursor, defaulting to the start of the log", () => {
    const ticket = signStreamTicket({ workspaceId: "ws-a", taskId: "task-1" }, SECRET, NOW);
    const withCursor = authorizeUpgrade(url({ ticket, since: "7" }), deps);
    expect(withCursor.ok && withCursor.data.since).toBe(7);
    const bare = authorizeUpgrade(url({ ticket }), deps);
    expect(bare.ok && bare.data.since).toBe(-1);
    const junk = authorizeUpgrade(url({ ticket, since: "nonsense" }), deps);
    expect(junk.ok && junk.data.since).toBe(-1);
  });
});

describe("attachSubscriber (reconnect replay)", () => {
  let db: TestDb;

  beforeEach(async () => {
    db = createTestDb();
    for (const id of ["ws-a", "ws-b"]) {
      await db.insert(workspace).values({ id, name: id, ownerUserId: "owner" });
    }
  });

  /** Minimal rows for a Task with a Session carrying `count` stdout events. */
  async function seedEvents(workspaceId: string, taskId: string, count: number): Promise<void> {
    const suffix = `${workspaceId}-${taskId}`;
    await db.insert(issue).values({ id: `issue-${suffix}`, workspaceId, title: "Issue" });
    await db.insert(agentCatalog).values({
      id: `catalog-${suffix}`,
      workspaceId,
      key: "claude_code",
      displayName: "Claude Code",
      protocol: "claude_code_stream_json",
      command: "claude",
      subscriptionEnvVar: "CLAUDE_CODE_OAUTH_TOKEN",
      meteredEnvVar: "ANTHROPIC_API_KEY",
    });
    await db.insert(agentProfile).values({
      id: `agent-${suffix}`,
      workspaceId,
      name: "Claude",
      agentCatalogId: `catalog-${suffix}`,
      authMode: "subscription",
      secretId: `secret-${suffix}`,
    });
    await db
      .insert(executorProfile)
      .values({ id: `exec-${suffix}`, workspaceId, name: "Local", kind: "local" });
    await db.insert(repository).values({
      id: `repo-${suffix}`,
      workspaceId,
      name: "repo",
      source: "local_path",
      location: `/srv/${suffix}`,
    });
    await db.insert(task).values({
      id: taskId,
      workspaceId,
      issueId: `issue-${suffix}`,
      title: "Task",
      state: "running",
      agentProfileId: `agent-${suffix}`,
      executorProfileId: `exec-${suffix}`,
    });
    await db.insert(taskRepository).values({
      id: `attach-${taskId}`,
      workspaceId,
      taskId,
      repositoryId: `repo-${suffix}`,
      checkoutBranch: `solow/task-${taskId}`,
    });
    await db.insert(session).values({ id: `sess-${taskId}`, workspaceId, taskId, state: "active" });
    for (let seq = 0; seq < count; seq++) {
      await db.insert(sessionEvent).values({
        id: `${taskId}-ev-${seq}`,
        workspaceId,
        sessionId: `sess-${taskId}`,
        seq,
        kind: "stdout",
        payload: { text: `line ${seq}\n` },
      });
    }
  }

  it("replays only the events after the client's cursor", async () => {
    await seedEvents("ws-a", "task-1", 4);
    const sent: TaskEvent[] = [];
    const claims = { workspaceId: "ws-a", taskId: "task-1", exp: NOW + 60_000 };

    const unsubscribe = await attachSubscriber(
      { db },
      { claims, channel: "ws:ws-a:task:task-1", since: 1 },
      (m) => sent.push(m),
    );
    unsubscribe();

    expect(sent.map((e) => ("seq" in e ? e.seq : -1))).toEqual([2, 3]);
    expect(sent.every((e) => e.kind === "stdout")).toBe(true);
  });

  it("does not replay another Workspace's events for the same task id (Principle V)", async () => {
    await seedEvents("ws-a", "task-1", 3);
    const sent: TaskEvent[] = [];
    // A ws-b ticket naming ws-a's task id: the query is Workspace-scoped, so nothing comes back.
    const claims = { workspaceId: "ws-b", taskId: "task-1", exp: NOW + 60_000 };

    const unsubscribe = await attachSubscriber(
      { db },
      { claims, channel: "ws:ws-b:task:task-1", since: -1 },
      (m) => sent.push(m),
    );
    unsubscribe();

    expect(sent).toHaveLength(0);
  });

  it("delivers live events published after the replay, without duplicating replayed ones", async () => {
    await seedEvents("ws-a", "task-2", 2);
    const sent: TaskEvent[] = [];
    const claims = { workspaceId: "ws-a", taskId: "task-2", exp: NOW + 60_000 };
    const channel = "ws:ws-a:task:task-2";

    const unsubscribe = await attachSubscriber({ db }, { claims, channel, since: -1 }, (m) =>
      sent.push(m),
    );
    hub.publish(channel, {
      kind: "stdout",
      taskId: "task-2",
      sessionId: "sess-task-2",
      seq: 2,
      text: "live\n",
      channel: "assistant",
    });
    unsubscribe();

    expect(sent.map((e) => ("seq" in e ? e.seq : -1))).toEqual([0, 1, 2]);
    // After unsubscribing, further publishes must not reach this client.
    hub.publish(channel, {
      kind: "stdout",
      taskId: "task-2",
      sessionId: "sess-task-2",
      seq: 3,
      text: "after\n",
      channel: "assistant",
    });
    expect(sent).toHaveLength(3);
  });

  it("board subscriptions carry no task replay — only live status", async () => {
    const sent: TaskEvent[] = [];
    const claims = { workspaceId: "ws-a", taskId: null, exp: NOW + 60_000 };
    const channel = "ws:ws-a:board";

    const unsubscribe = await attachSubscriber({ db }, { claims, channel, since: -1 }, (m) =>
      sent.push(m),
    );
    expect(sent).toHaveLength(0);
    hub.publish(channel, {
      kind: "status",
      taskId: "task-1",
      state: "review",
      at: "2026-01-01T00:00:00.000Z",
    });
    unsubscribe();

    expect(sent).toEqual([
      { kind: "status", taskId: "task-1", state: "review", at: "2026-01-01T00:00:00.000Z" },
    ]);
  });
});

describe("handleClientFrame (operator input and stop)", () => {
  const claims = (over: Partial<{ workspaceId: string; taskId: string | null }> = {}) => ({
    workspaceId: "ws-a",
    taskId: "task-1" as string | null,
    exp: NOW + 60_000,
    ...over,
  });

  function liveAgent() {
    const state = {
      inputs: [] as string[],
      stopped: false,
      outcome: Promise.resolve({ kind: "completed" as const }),
      workspacePath: Promise.resolve<string | null>("/wt/solow-task-1"),
      async send(text: string) {
        state.inputs.push(text);
        return true;
      },
      async stop() {
        state.stopped = true;
      },
    };
    return state satisfies AgentHandle;
  }

  function withAgent(workspaceId: string, taskId: string) {
    const registry = new AgentRegistry();
    const handle = liveAgent();
    registry.register(workspaceId, { taskId, sessionId: "sess-1", handle });
    return { registry, handle };
  }

  it("delivers input to the agent of the Task the ticket authorized", async () => {
    const { registry, handle } = withAgent("ws-a", "task-1");
    const result = await handleClientFrame(
      { registry },
      claims(),
      JSON.stringify({ kind: "input", taskId: "task-1", data: "also add a test" }),
    );
    expect(result).toEqual({ ok: true, action: "input" });
    expect(handle.inputs).toEqual(["also add a test"]);
  });

  it("stops the agent of the Task the ticket authorized", async () => {
    const { registry, handle } = withAgent("ws-a", "task-1");
    const result = await handleClientFrame(
      { registry },
      claims(),
      JSON.stringify({ kind: "stop", taskId: "task-1" }),
    );
    expect(result).toEqual({ ok: true, action: "stop" });
    expect(handle.stopped).toBe(true);
  });

  it("refuses a frame naming a Task the ticket does not cover (Principle V)", async () => {
    // The ticket authorizes task-1; the frame asks to steer task-9. The channel a client may
    // *read* and the agent it may *steer* have to be the same one.
    const { registry, handle } = withAgent("ws-a", "task-9");
    const result = await handleClientFrame(
      { registry },
      claims(),
      JSON.stringify({ kind: "input", taskId: "task-9", data: "steer someone else" }),
    );
    expect(result).toEqual({ ok: false, error: "frame_not_authorized" });
    expect(handle.inputs).toEqual([]);
  });

  it("refuses steering from a board subscription, which names no Task at all", async () => {
    const { registry, handle } = withAgent("ws-a", "task-1");
    const result = await handleClientFrame(
      { registry },
      claims({ taskId: null }),
      JSON.stringify({ kind: "stop", taskId: "task-1" }),
    );
    expect(result).toEqual({ ok: false, error: "frame_not_authorized" });
    expect(handle.stopped).toBe(false);
  });

  it("cannot reach another Workspace's agent that shares the Task id", async () => {
    const { registry, handle } = withAgent("ws-b", "task-1");
    const result = await handleClientFrame(
      { registry },
      claims(),
      JSON.stringify({ kind: "input", taskId: "task-1", data: "cross-tenant" }),
    );
    expect(result).toEqual({ ok: false, error: "agent_not_running" });
    expect(handle.inputs).toEqual([]);
  });

  it("says so when no agent is running, rather than pretending the input landed", async () => {
    const result = await handleClientFrame(
      { registry: new AgentRegistry() },
      claims(),
      JSON.stringify({ kind: "input", taskId: "task-1", data: "anyone there?" }),
    );
    expect(result).toEqual({ ok: false, error: "agent_not_running" });
  });

  it("rejects a malformed frame without throwing", async () => {
    const registry = new AgentRegistry();
    for (const raw of ["not json", JSON.stringify({ kind: "delete-everything" }), "", null]) {
      expect(await handleClientFrame({ registry }, claims(), raw)).toEqual({
        ok: false,
        error: "frame_malformed",
      });
    }
  });
});

/**
 * Answering a permission over the same socket that carries input and stop (issue #58, AC-4).
 * The tenancy question is the same one the other two frames face, so it is asked the same way.
 */
describe("handleClientFrame (permission answers)", () => {
  const claims = (over: Partial<{ workspaceId: string; taskId: string | null }> = {}) => ({
    workspaceId: "ws-a",
    taskId: "task-1" as string | null,
    exp: NOW + 60_000,
    ...over,
  });

  function permissionAgent(answer: PermissionAnswer = "answered") {
    const answers: Array<{ requestId: string; optionId: string }> = [];
    const handle: AgentHandle = {
      outcome: Promise.resolve({ kind: "completed" as const }),
      workspacePath: Promise.resolve<string | null>("/wt/solow-task-1"),
      async send() {
        return true;
      },
      async respondPermission(requestId: string, optionId: string) {
        answers.push({ requestId, optionId });
        return answer;
      },
      async stop() {},
    };
    return { handle, answers };
  }

  it("delivers the operator's choice to the agent of the Task the ticket authorized", async () => {
    const registry = new AgentRegistry();
    const { handle, answers } = permissionAgent();
    registry.register("ws-a", { taskId: "task-1", sessionId: "sess-1", handle });

    const result = await handleClientFrame(
      { registry },
      claims(),
      JSON.stringify({
        kind: "permission",
        taskId: "task-1",
        requestId: "req-1",
        optionId: "allow",
      }),
    );

    expect(result).toEqual({ ok: true, action: "permission" });
    expect(answers).toEqual([{ requestId: "req-1", optionId: "allow" }]);
  });

  it("refuses to answer a permission for a Task the ticket does not cover (Principle V)", async () => {
    const registry = new AgentRegistry();
    const { handle, answers } = permissionAgent();
    registry.register("ws-a", { taskId: "task-9", sessionId: "sess-9", handle });

    const result = await handleClientFrame(
      { registry },
      claims(),
      JSON.stringify({
        kind: "permission",
        taskId: "task-9",
        requestId: "req-1",
        optionId: "allow",
      }),
    );

    expect(result).toEqual({ ok: false, error: "frame_not_authorized" });
    expect(answers).toEqual([]);
  });

  it("tells the operator when their answer reached no running agent", async () => {
    // A dialog left open across the end of a run must not look as though it were answered.
    const result = await handleClientFrame(
      { registry: new AgentRegistry() },
      claims(),
      JSON.stringify({
        kind: "permission",
        taskId: "task-1",
        requestId: "req-1",
        optionId: "allow",
      }),
    );
    expect(result).toEqual({ ok: false, error: "agent_not_running" });
  });

  it("does not call a running agent absent just because its question was already settled", async () => {
    // The operator's dialog sat open past the deadline and the policy answered for them. The
    // agent is mid-turn, streaming into the terminal they are looking at; reporting it as gone
    // is a statement they can see is false, and it hides the thing that actually happened.
    const registry = new AgentRegistry();
    const { handle } = permissionAgent("not_pending");
    registry.register("ws-a", { taskId: "task-1", sessionId: "sess-1", handle });

    const result = await handleClientFrame(
      { registry },
      claims(),
      JSON.stringify({
        kind: "permission",
        taskId: "task-1",
        requestId: "req-1",
        optionId: "allow",
      }),
    );

    expect(result).toEqual({ ok: false, error: "permission_not_pending" });
  });

  it("says so when the option clicked is not one the agent offered", async () => {
    const registry = new AgentRegistry();
    const { handle } = permissionAgent("option_not_offered");
    registry.register("ws-a", { taskId: "task-1", sessionId: "sess-1", handle });

    const result = await handleClientFrame(
      { registry },
      claims(),
      JSON.stringify({
        kind: "permission",
        taskId: "task-1",
        requestId: "req-1",
        optionId: "sudo",
      }),
    );

    expect(result).toEqual({ ok: false, error: "permission_option_unknown" });
  });

  it("says so when the agent's protocol has no permission channel at all", async () => {
    const registry = new AgentRegistry();
    registry.register("ws-a", {
      taskId: "task-1",
      sessionId: "sess-1",
      handle: {
        outcome: Promise.resolve({ kind: "completed" as const }),
        workspacePath: Promise.resolve<string | null>("/wt/solow-task-1"),
        async send() {
          return true;
        },
        async stop() {},
      },
    });

    const result = await handleClientFrame(
      { registry },
      claims(),
      JSON.stringify({
        kind: "permission",
        taskId: "task-1",
        requestId: "req-1",
        optionId: "allow",
      }),
    );

    expect(result).toEqual({ ok: false, error: "permission_unsupported" });
  });
});
