/// <reference types="bun-types" />

import { beforeEach, describe, expect, it } from "bun:test";
import type { SessionEventPayload, TaskEvent } from "@solow/contracts";
import {
  executorProfile,
  harnessCatalog,
  harnessProfile,
  issue,
  session,
  sessionEvent,
  task,
  workspace,
} from "@solow/db";
import { createTestDb, type TestDb } from "@solow/db/testing";
import { compactSession } from "../data.js";
import { attachSubscriber, toTaskEvent } from "./replay.js";

/**
 * The one projection from stored record to wire frame (issue #2, AC-5), and the property the
 * whole compaction design exists to protect: what a reconnecting client is handed does not
 * change because a range was summarised.
 *
 * `stream.test.ts` covers reconnect replay itself and is deliberately untouched by this issue —
 * it seeds rows in the shape earlier runs wrote and expects the frames they always produced.
 * What is asserted here is the layer underneath it.
 */

const CLAIMS = { workspaceId: "ws-a", taskId: "task-1", exp: 2_000_000_000_000 };

describe("toTaskEvent", () => {
  it("carries thinking as a channel, not as a marker baked into the text", () => {
    // The "· " prefix used to be glued on here. That made thinking indistinguishable from an
    // answer that happens to start with a bullet, and forced every client to parse presentation
    // back out of the text. The channel is data; the marker, if any, is the terminal's choice.
    expect(
      toTaskEvent(
        { kind: "assistant_turn", text: "considering", thinking: true },
        "t",
        "s",
        4,
        null,
      ),
    ).toEqual({
      kind: "stdout",
      taskId: "t",
      workflowStepId: null,
      sessionId: "s",
      seq: 4,
      text: "considering",
      channel: "thinking",
    });
    expect(
      toTaskEvent(
        { kind: "assistant_turn", text: "considering", thinking: false },
        "t",
        "s",
        4,
        null,
      ),
    ).toEqual({
      kind: "stdout",
      taskId: "t",
      workflowStepId: null,
      sessionId: "s",
      seq: 4,
      text: "considering",
      channel: "assistant",
    });
  });

  it("keeps an operator's own steering, machine output and the model's answer apart", () => {
    // All three used to arrive as an untagged `stdout` frame, so the terminal rendered them
    // identically and could not, for instance, render markdown for prose but not for a mode
    // switch. Telling them apart on the wire is what makes that possible at all.
    expect(toTaskEvent({ kind: "user_turn", text: "steer left" }, "t", "s", 1, null)).toMatchObject(
      {
        kind: "stdout",
        text: "steer left",
        channel: "user",
      },
    );
    expect(
      toTaskEvent({ kind: "notice", text: "mode: acceptEdits" }, "t", "s", 2, null),
    ).toMatchObject({
      kind: "stdout",
      text: "mode: acceptEdits",
      channel: "system",
    });
  });

  it("carries a tool call's id, so a client can fold it together with its result", () => {
    expect(
      toTaskEvent(
        { kind: "tool_call", name: "Edit", callId: "c1", input: { file_path: "a.ts" } },
        "t",
        "s",
        2,
        null,
      ),
    ).toMatchObject({ kind: "tool_use", name: "Edit", callId: "c1", input: { file_path: "a.ts" } });
  });

  it("gives a tool result a wire form at all — it previously had none", () => {
    expect(
      toTaskEvent(
        { kind: "tool_result", callId: "c1", ok: false, output: "boom" },
        "t",
        "s",
        3,
        null,
      ),
    ).toMatchObject({ kind: "tool_result", callId: "c1", ok: false, output: "boom" });
  });

  it("replays a permission as itself, so a reconnecting operator can still answer it", () => {
    expect(
      toTaskEvent(
        {
          kind: "permission_request",
          requestId: "req-1",
          title: "Write .env",
          toolKind: "edit",
          options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
        },
        "t",
        "s",
        3,
        null,
      ),
    ).toEqual({
      kind: "permission_request",
      taskId: "t",
      workflowStepId: null,
      sessionId: "s",
      seq: 3,
      toolCallId: null,
      requestId: "req-1",
      title: "Write .env",
      toolKind: "edit",
      options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
    });
  });

  it("replays the harness's todo list whole, so a client that joined late still has the plan", () => {
    // The list is stored entire on every rewrite rather than as a delta, which is what makes a
    // reconnect work at all: there is nothing for a late client to apply a delta to.
    expect(
      toTaskEvent(
        {
          kind: "todos",
          items: [{ content: "Record the list", status: "in_progress", activeForm: "Recording" }],
        },
        "t",
        "s",
        7,
        null,
      ),
    ).toEqual({
      kind: "todos",
      taskId: "t",
      workflowStepId: null,
      sessionId: "s",
      seq: 7,
      items: [{ content: "Record the list", status: "in_progress", activeForm: "Recording" }],
    });
  });

  it("has no wire form for a record nothing streams", () => {
    expect(
      toTaskEvent({ kind: "state", from: "running", to: "review" }, "t", "s", 5, null),
    ).toBeNull();
    expect(
      toTaskEvent(
        {
          kind: "usage",
          model: null,
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
        "t",
        "s",
        6,
        null,
      ),
    ).toBeNull();
  });
});

describe("attachSubscriber (typed log, unchanged wire)", () => {
  let db: TestDb;

  beforeEach(async () => {
    db = createTestDb();
    await db.insert(workspace).values({ id: "ws-a", name: "Alpha", ownerUserId: "owner" });
    await db.insert(issue).values({ id: "iss-1", workspaceId: "ws-a", title: "I" });
    await db.insert(harnessCatalog).values({
      id: "cat-1",
      workspaceId: "ws-a",
      key: "claude_code",
      displayName: "Claude Code",
      protocol: "claude_code_stream_json",
      command: "claude",
      subscriptionEnvVar: "CLAUDE_CODE_OAUTH_TOKEN",
      meteredEnvVar: "ANTHROPIC_API_KEY",
    });
    await db.insert(harnessProfile).values({
      id: "ap-1",
      workspaceId: "ws-a",
      name: "Claude",
      agentCatalogId: "cat-1",
      authMode: "subscription",
      secretId: "sec-1",
    });
    await db
      .insert(executorProfile)
      .values({ id: "ep-1", workspaceId: "ws-a", name: "Local", kind: "local" });
    await db.insert(task).values({
      id: "task-1",
      workspaceId: "ws-a",
      issueId: "iss-1",
      title: "Task",
      state: "running",
      agentProfileId: "ap-1",
      executorProfileId: "ep-1",
    });
    await db.insert(session).values({
      id: "sess-1",
      workspaceId: "ws-a",
      taskId: "task-1",
      state: "active",
    });
  });

  /** Rows exactly as the log holds them — `kind` and payload passed straight through. */
  async function seed(
    rows: Array<{ seq: number; kind: string; payload: unknown; workflowStepId?: string }>,
  ) {
    for (const row of rows) {
      await db.insert(sessionEvent).values({
        id: `ev-${row.seq}`,
        workspaceId: "ws-a",
        sessionId: "sess-1",
        seq: row.seq,
        kind: row.kind,
        payload: row.payload,
        // Left unset by default, which is a row written before the column existed — the
        // population the reconnect path has to keep replaying unchanged.
        ...(row.workflowStepId ? { workflowStepId: row.workflowStepId } : {}),
      });
    }
  }

  const typed = (seq: number, payload: SessionEventPayload) => ({
    seq,
    kind: payload.kind,
    payload,
  });

  async function replay(since = -1): Promise<TaskEvent[]> {
    const sent: TaskEvent[] = [];
    const unsubscribe = await attachSubscriber(
      { db },
      { claims: CLAIMS, channel: "ws:ws-a:task:task-1", since },
      (m) => sent.push(m),
    );
    unsubscribe();
    return sent;
  }

  it("hands a reconnecting client the Step each row was produced under", async () => {
    /*
     * The whole point of the column reaching the wire: a client that drops its socket mid-run
     * and comes back has to be able to rebuild the same per-Step transcript it had, without
     * re-deriving Step boundaries from the `workflow_decision` lines scattered through the log.
     *
     * The unattributed row is seeded alongside deliberately. It is what every row written before
     * this column existed looks like, and it must still replay — as `null`, which a client reads
     * as "no Step", never as a Step of its own.
     */
    await seed([
      { seq: 0, kind: "assistant_turn", payload: { kind: "assistant_turn", text: "planning\n" } },
      {
        seq: 1,
        kind: "assistant_turn",
        payload: { kind: "assistant_turn", text: "building\n" },
        workflowStepId: "step-build",
      },
    ]);

    expect(
      (await replay()).map((f) => ("workflowStepId" in f ? f.workflowStepId : undefined)),
    ).toEqual([null, "step-build"]);
  });

  it("replays a row written before the typed union as the frame it always produced", async () => {
    await seed([
      { seq: 0, kind: "stdout", payload: { text: "line 0\n" } },
      { seq: 1, kind: "tool_use", payload: { name: "Edit" } },
    ]);

    expect(await replay()).toEqual([
      {
        kind: "stdout",
        taskId: "task-1",
        // A row from before the column existed replays as unattributed, never as a Step.
        workflowStepId: null,
        sessionId: "sess-1",
        seq: 0,
        text: "line 0\n",
        channel: "assistant",
      },
      {
        kind: "tool_use",
        taskId: "task-1",
        workflowStepId: null,
        sessionId: "sess-1",
        seq: 1,
        name: "Edit",
        callId: null,
        input: null,
        status: null,
      },
    ]);
  });

  it("replays a typed row to the very same frame as its pre-union equivalent", async () => {
    // The two eras have to be indistinguishable on the wire, or a client reading a Task whose
    // rounds straddle the change would see its own history change shape mid-transcript.
    await seed([typed(0, { kind: "assistant_turn", text: "line 0\n", thinking: false })]);
    expect(await replay()).toEqual([
      {
        kind: "stdout",
        taskId: "task-1",
        workflowStepId: null,
        sessionId: "sess-1",
        seq: 0,
        text: "line 0\n",
        channel: "assistant",
      },
    ]);
  });

  it("does not stream a state record, but still counts it when resuming from a cursor", async () => {
    // The cursor has to advance past a record with no wire form; if it did not, the next live
    // event would be dropped as one the replay had supposedly already covered.
    await seed([
      typed(0, { kind: "assistant_turn", text: "a", thinking: false }),
      typed(1, { kind: "state", from: "running", to: "review" }),
      typed(2, { kind: "assistant_turn", text: "b", thinking: false }),
    ]);

    const sent = await replay();
    expect(sent.map((e) => ("seq" in e ? e.seq : -1))).toEqual([0, 2]);
    expect(await replay(1)).toHaveLength(1);
  });

  it("delivers exactly the same frames before and after a range is compacted (AC-3)", async () => {
    for (let seq = 0; seq < 60; seq++) {
      await seed([typed(seq, { kind: "assistant_turn", text: `line ${seq}`, thinking: false })]);
    }
    const before = await replay();

    const planned = await compactSession(db, "ws-a", "sess-1", { threshold: 20, tail: 10 });
    expect(planned).toHaveLength(1);

    // Replay reads the events, not the summaries, and compaction never touched the events —
    // so a summarised session replays losslessly and the review gate keeps its evidence.
    expect(await replay()).toEqual(before);
  });
});

describe("a workflow decision on the wire", () => {
  it("reaches the terminal as one machine line, worded once for live and replay alike", () => {
    const frame = toTaskEvent(
      {
        kind: "workflow_decision",
        stepId: "s-review",
        stepName: "Review",
        signal: "agent-signal",
        gate: "auto",
        needsApproval: false,
        condition: { when: { kind: "outcome", is: "blocked" }, holds: true },
        status: "advanced",
        nextStepId: "s-escalate",
        nextStepName: "Escalate",
        outcome: "blocked",
        producedChanges: false,
      },
      "t",
      "s",
      9,
      // The Step the decision is *about*. Not `nextStepId`: this line closes the transcript of
      // the Step that just finished, and filing it under the Step being entered would open that
      // Step's transcript with a verdict on work its reader has not seen.
      "s-review",
    );
    expect(frame).toEqual({
      kind: "stdout",
      taskId: "t",
      workflowStepId: "s-review",
      sessionId: "s",
      seq: 9,
      channel: "system",
      text: 'Workflow: step "Review" finished (the harness signalled done). Condition did the harness report `blocked`? → yes. Advanced to "Escalate".',
    });
  });

  it("segments by the Step the decision closes, not the one it opens", () => {
    /*
     * The flattening to a `stdout` line is kept, so the only thing that can carry the Step here
     * is the column beside the frame. Red under a projection that reads `stepId` out of the
     * payload for this kind and leaves every other kind unattributed, and red under one that
     * files the decision under `nextStepId` — where it would head the *next* Step's transcript.
     */
    const decision = {
      kind: "workflow_decision",
      stepId: "s-build",
      stepName: "Build",
      signal: "review",
      gate: "human",
      needsApproval: true,
      condition: null,
      status: "advanced",
      nextStepId: "s-ship",
      nextStepName: "Ship",
      outcome: null,
      producedChanges: true,
    } as const;
    const frame = toTaskEvent(decision, "t", "s", 3, "s-build");
    expect(frame).toMatchObject({ kind: "stdout", workflowStepId: "s-build" });
  });
});
