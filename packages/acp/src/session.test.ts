/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import type { AcpUpdate } from "./protocol.js";
import {
  type AcpPermissionDecision,
  type AcpPermissionRequest,
  type AcpSessionOptions,
  type ChildProcessHandle,
  startAcpSession,
} from "./session.js";
import { type AcpScript, scriptedAcpPeer } from "./testing.js";

/**
 * ACP protocol conformance, against the scripted peer rather than a live agent (Principle VI).
 *
 * The peer speaks the real wire protocol, so what is exercised here is SoloW's own
 * framing, handshake, permission and cancellation paths — not a stub standing in for them.
 */

function drive(
  script: AcpScript = {},
  over: Partial<AcpSessionOptions> = {},
  prompt = "fix the latch",
) {
  const updates: AcpUpdate[] = [];
  const peer = scriptedAcpPeer(script);
  const session = startAcpSession(
    {
      command: "scripted-agent",
      cwd: "/wt/task-1",
      env: { PATH: "/usr/bin" },
      spawn: () => peer,
      onUpdate: (u) => updates.push(u),
      cancelGraceMs: 50,
      exitGraceMs: 20,
      ...over,
    },
    prompt,
  );
  return {
    session,
    updates,
    peer,
    text: () => updates.flatMap((u) => (u.kind === "text" ? [u.text] : [])),
  };
}

describe("startAcpSession — the handshake (AC-1)", () => {
  it("drives initialize, then session/new, then session/prompt, in that order", async () => {
    const { session, peer } = drive({ turns: [{ text: ["patched the latch"] }] });
    const outcome = await session.outcome;

    expect(outcome).toEqual({ ok: true, stopReason: "end_turn", error: null });
    expect(peer.methods.slice(0, 3)).toEqual(["initialize", "session/new", "session/prompt"]);
  });

  it("streams the agent's thinking and text in order, then a result", async () => {
    const { session, updates } = drive({
      turns: [{ thought: ["considering"], toolCalls: ["Edit src/latch.ts"], text: ["done"] }],
    });
    await session.outcome;

    expect(updates.filter((u) => u.kind !== "session" && u.kind !== "usage")).toEqual([
      { kind: "text", channel: "thinking", text: "considering" },
      {
        kind: "tool_call",
        name: "Edit src/latch.ts",
        toolCallId: "call-Edit src/latch.ts",
        status: "in_progress",
      },
      { kind: "text", channel: "assistant", text: "done" },
      { kind: "result", ok: true, stopReason: "end_turn", error: null },
    ]);
  });

  it("announces the working directory it was given, since ACP has no worktree of its own", async () => {
    const { session, updates } = drive();
    await session.outcome;
    expect(updates[0]).toEqual({ kind: "session", sessionId: "acp-session-1", cwd: "/wt/task-1" });
    expect(await session.sessionId).toBe("acp-session-1");
  });

  it("reassembles frames the agent split across write boundaries", async () => {
    // The peer writes every frame in two halves; a client that parsed per chunk would lose them.
    const { session, text } = drive({ splitFrames: true, turns: [{ text: ["half a frame"] }] });
    expect((await session.outcome).ok).toBe(true);
    expect(text()).toContain("half a frame");
  });

  it("reports one usage record per completed turn, stating that nothing was reported", async () => {
    // ACP v1 has no token accounting. The turn is still recorded so the gap is visible rather
    // than looking like a turn that cost nothing (issue #14).
    const { session, updates } = drive({ turns: [{ text: ["a"] }] });
    await session.outcome;
    const usage = updates.filter((u) => u.kind === "usage");
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ reported: false, inputTokens: 0, model: null });
  });
});

describe("startAcpSession — turn taking", () => {
  it("queues operator input as the next prompt rather than interleaving it", async () => {
    // ACP v1 offers no way to type into a running turn, so two prompts must never be in flight.
    const { session, peer, text } = drive({
      turns: [{ text: ["first pass"] }, { text: ["added the test"] }],
    });
    expect(await session.send("also add a regression test")).toBe(true);
    await session.outcome;

    expect(peer.methods.filter((m) => m === "session/prompt")).toHaveLength(2);
    expect(text()).toEqual(["first pass", "added the test"]);
  });

  it("refuses input once the session has finished rather than swallowing it", async () => {
    const { session } = drive({ turns: [{ text: ["done"] }] });
    await session.outcome;
    expect(await session.send("too late")).toBe(false);
  });

  it("gives the Task brief the first turn even when the operator types during the handshake", async () => {
    // The reproduction of the ordering defect: an operator whose socket is already open can
    // land a frame before `initialize` has answered. Their message must queue *behind* the
    // brief — an agent whose first prompt is "use the existing helper", with no task in it,
    // has been given a steering message instead of a job.
    const prompts: string[] = [];
    const peer = scriptedAcpPeer({ turns: [{ text: ["first pass"] }, { text: ["second pass"] }] });
    const watched = {
      ...peer,
      stdin: {
        ...peer.stdin,
        write: (data: string) => {
          for (const line of data.split("\n")) {
            if (!line.trim()) continue;
            const frame = JSON.parse(line) as {
              method?: string;
              params?: { prompt?: Array<{ text?: string }> };
            };
            if (frame.method === "session/prompt") {
              prompts.push(frame.params?.prompt?.map((b) => b.text ?? "").join("") ?? "");
            }
          }
          return peer.stdin.write(data);
        },
      },
    };

    const session = startAcpSession(
      {
        command: "scripted-agent",
        cwd: "/wt/task-1",
        env: {},
        spawn: () => watched,
        onUpdate: () => {},
        cancelGraceMs: 50,
        exitGraceMs: 20,
      },
      "THE TASK BRIEF",
    );
    // Synchronously, before anything of the handshake has resolved.
    const accepted = session.send("OPERATOR TYPED THIS");

    expect(await accepted).toBe(true);
    await session.outcome;
    expect(prompts).toEqual(["THE TASK BRIEF", "OPERATOR TYPED THIS"]);
  });

  it("refuses input when the handshake never finished, rather than claiming it was accepted", async () => {
    // Nothing can be queued behind a brief that will never be sent, so saying "accepted" would
    // be a lie the terminal repeats to the operator.
    const { session } = drive({ failInitialize: "no credential configured" });
    expect(await session.send("are you there?")).toBe(false);
    await session.outcome;
  });
});

describe("startAcpSession — capability refusal (AC-2)", () => {
  it("answers a client method it never advertised with -32601, and the run carries on", async () => {
    // This is the case that actually protects something: `fs/*` is how an agent would otherwise
    // reach outside its worktree through the orchestrator.
    const { session, text } = drive({
      turns: [{ callsClientMethod: "fs/read_text_file", text: ["carried on"] }],
    });

    expect((await session.outcome).ok).toBe(true);
    expect(text()).toContain("client refused with -32601");
    expect(text()).toContain("carried on");
  });

  it("never sends session/load to an agent that did not advertise loadSession", async () => {
    const { session, peer } = drive({}, { resumeSessionId: "old-session" });
    const outcome = await session.outcome;

    expect(peer.methods).not.toContain("session/load");
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("loadSession");
  });

  it("sends session/load when the agent did advertise it", async () => {
    const { session, peer } = drive(
      { agentCapabilities: { loadSession: true } },
      { resumeSessionId: "old-session" },
    );
    await session.outcome;
    expect(peer.methods).toContain("session/load");
    expect(peer.methods).not.toContain("session/new");
  });

  it("never selects a mode the agent did not offer", async () => {
    const { session, peer } = drive({}, { modeId: "plan" });
    await session.outcome;
    expect(peer.methods).not.toContain("session/set_mode");
  });

  it("selects a mode the agent did offer", async () => {
    const { session, peer } = drive(
      { modes: { currentModeId: "code", availableModes: [{ id: "plan", name: "Plan" }] } },
      { modeId: "plan" },
    );
    await session.outcome;
    expect(peer.methods).toContain("session/set_mode");
  });

  it("reports what the agent advertised, as ids, before anything is chosen from it", async () => {
    // Issue #94 AC-2: this update is the only moment the lists exist — `session/new` is where
    // ACP advertises them — so it is what a cache has to read. Ids, because an id is what a
    // Profile's pin and `session/set_mode` actually take.
    const { session, updates } = drive({
      modes: { availableModes: [{ id: "plan", name: "Plan" }] },
      models: { availableModels: [{ modelId: "claude-opus-4" }, { modelId: "claude-sonnet-4" }] },
    });
    await session.outcome;

    const advertised = updates.filter((u) => u.kind === "capabilities");
    expect(advertised).toEqual([
      { kind: "capabilities", models: ["claude-opus-4", "claude-sonnet-4"], modes: ["plan"] },
    ]);
  });

  it("says nothing when the agent advertised nothing — silence is not the empty list", async () => {
    // A consumer caching these must be able to tell "said nothing" from "offers nothing", or
    // one silent agent would blank a cache another run filled.
    const { session, updates } = drive({});
    await session.outcome;

    expect(updates.filter((u) => u.kind === "capabilities")).toEqual([]);
  });

  it("fails the run when the agent speaks a protocol version this client cannot drive", async () => {
    const { session } = drive({ protocolVersion: 0 });
    const outcome = await session.outcome;
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("protocol version 0");
  });
});

describe("startAcpSession — permissions (AC-4)", () => {
  const options = [
    { optionId: "allow", name: "Allow once", kind: "allow_once" },
    { optionId: "deny", name: "Reject", kind: "reject_once" },
  ];

  it("asks the operator, and sends back the option they chose", async () => {
    const asked: AcpPermissionRequest[] = [];
    const { session, text } = drive(
      { turns: [{ permission: { title: "Write .env", options }, text: ["wrote it"] }] },
      {
        onPermission: async (request): Promise<AcpPermissionDecision> => {
          asked.push(request);
          return { outcome: "selected", optionId: "allow" };
        },
      },
    );

    expect((await session.outcome).ok).toBe(true);
    expect(asked).toHaveLength(1);
    expect(asked[0]?.title).toBe("Write .env");
    expect(asked[0]?.options).toEqual(options);
    expect(text()).toContain("permission selected:allow");
  });

  it("never puts the tool call's raw input in front of the operator (Principle IV)", async () => {
    const asked: AcpPermissionRequest[] = [];
    const { session } = drive(
      {
        turns: [
          {
            permission: {
              title: "Write .env",
              rawInput: { path: ".env", content: "ANTHROPIC_API_KEY=sk-leaked" },
              options,
            },
          },
        ],
      },
      {
        onPermission: async (request) => {
          asked.push(request);
          return { outcome: "selected", optionId: "allow" };
        },
      },
    );
    await session.outcome;

    expect(JSON.stringify(asked)).not.toContain("sk-leaked");
  });

  it("gives two runs of the same Task different request ids", async () => {
    // The agent's own JSON-RPC ids restart at 1 in every spawned process, and the SPA pairs a
    // request with its resolution across the Task's *whole* replayed history. Two rounds both
    // asking as "1" made the second look like a question already answered, so the operator was
    // never shown it and the deadline policy settled it instead.
    const ask = async () => {
      const seen: AcpPermissionRequest[] = [];
      const { session } = drive(
        { turns: [{ permission: { title: "Write .env", options } }] },
        {
          onPermission: async (request) => {
            seen.push(request);
            return { outcome: "selected", optionId: "allow" };
          },
        },
      );
      await session.outcome;
      return seen[0]?.requestId ?? "";
    };

    const [first, second] = [await ask(), await ask()];
    expect(first).not.toBe("");
    expect(second).not.toBe(first);
  });

  it("gives two questions in one run different request ids too", async () => {
    const seen: AcpPermissionRequest[] = [];
    const { session } = drive(
      {
        turns: [
          { permission: { title: "Write .env", options }, text: ["one"] },
          { permission: { title: "Run the tests", options }, text: ["two"] },
        ],
      },
      {
        onPermission: async (request) => {
          seen.push(request);
          return { outcome: "selected", optionId: "allow" };
        },
      },
    );
    expect(await session.send("now run the tests")).toBe(true);
    await session.outcome;

    expect(seen).toHaveLength(2);
    expect(seen[0]?.requestId).not.toBe(seen[1]?.requestId);
  });

  it("declines when there is nobody to ask, rather than granting silently", async () => {
    // No `onPermission` handler means no operator. AC-4's whole point is that this is a refusal.
    const { session, text } = drive({
      turns: [{ permission: { title: "Delete the repository", options } }],
    });
    const outcome = await session.outcome;

    expect(text()).toContain("permission cancelled:");
    expect(outcome.stopReason).toBe("refusal");
    expect(outcome.ok).toBe(false);
  });
});

/** Poll until the run has actually got going, so a stop lands mid-turn rather than racing it. */
async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !predicate(); i++) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

describe("startAcpSession — stopping (AC-6)", () => {
  it("cancels the session and ends the process, reporting a stop as a completed run", async () => {
    // The turn hangs, so the stop is genuinely interrupting work rather than arriving after it.
    const { session, peer, text } = drive({ turns: [{ text: ["working"], hang: true }] });
    await waitFor(() => text().includes("working"));

    await session.stop();

    expect(peer.methods).toContain("session/cancel");
    // Principle I: whether the partial work is worth keeping is the reviewer's call, not ours.
    expect(await session.outcome).toEqual({ ok: true, stopReason: "cancelled", error: null });
    expect(await peer.exited).toBe(0);
  });

  it("kills an agent that ignores both the cancel and the closed stdin", async () => {
    const { session, peer, text } = drive({
      ignoreCancel: true,
      turns: [{ text: ["ignoring you"], hang: true }],
    });
    await waitFor(() => text().includes("ignoring you"));

    await session.stop();

    expect(peer.methods).toContain("session/cancel");
    expect(peer.killed).toBe(true);
    expect((await session.outcome).stopReason).toBe("cancelled");
  });

  it("escalates to SIGKILL for an agent that ignores the polite signal, and stays bounded", async () => {
    // The scripted peer exits the moment it is killed, so it cannot stand in for the child this
    // rung exists for: one that installs a SIGTERM handler and keeps running. This handle does.
    const peer = scriptedAcpPeer({
      ignoreCancel: true,
      turns: [{ text: ["ignoring you"], hang: true }],
    });
    const signals: Array<number | string | undefined> = [];
    let markExited: (code: number) => void = () => {};
    const stubborn: ChildProcessHandle = {
      ...peer,
      exited: new Promise<number>((resolve) => {
        markExited = resolve;
      }),
      kill: (signal?: number | string) => {
        signals.push(signal);
        // SIGTERM is caught and ignored; only SIGKILL ends it.
        if (signal === "SIGKILL") {
          peer.kill();
          markExited(137);
        }
      },
    };

    const updates: AcpUpdate[] = [];
    const session = startAcpSession(
      {
        command: "stubborn-agent",
        cwd: "/wt/task-1",
        env: {},
        spawn: () => stubborn,
        onUpdate: (u) => updates.push(u),
        cancelGraceMs: 50,
        exitGraceMs: 20,
        killGraceMs: 30,
      },
      "fix the latch",
    );
    await waitFor(() => updates.some((u) => u.kind === "text" && u.text === "ignoring you"));

    // Unbounded, this never resolves: the whole point is that the durable step is not hung.
    await session.stop();

    expect(signals).toEqual([undefined, "SIGKILL"]);
    expect((await session.outcome).stopReason).toBe("cancelled");
  });

  it("reports an outcome even when tearing the process down fails", async () => {
    // `terminate()` used to be awaited outside the try, so a throw from the kill or the stdout
    // pump rejected `outcome` — which skips the runner's cleanup and makes the durable step
    // retry a run it should have classified.
    const peer = scriptedAcpPeer({ turns: [{ text: ["done"] }] });
    const broken: ChildProcessHandle = {
      ...peer,
      kill: () => {
        throw new Error("the process handle is gone");
      },
    };
    const session = startAcpSession(
      {
        command: "broken-handle",
        cwd: "/wt/task-1",
        env: {},
        spawn: () => broken,
        onUpdate: () => {},
        exitGraceMs: 5,
        killGraceMs: 5,
      },
      "fix the latch",
    );

    expect(await session.outcome).toEqual({ ok: true, stopReason: "end_turn", error: null });
  });

  it("stopping a run that already finished is a no-op rather than an error", async () => {
    const { session } = drive({ turns: [{ text: ["done"] }] });
    await session.outcome;
    await session.stop();
    expect((await session.outcome).ok).toBe(true);
  });
});

describe("startAcpSession — failure", () => {
  it("reports no_result when the agent dies before answering anything", async () => {
    const { session } = drive({ dieEarly: true, stderr: "usage limit reached\n" });
    const outcome = await session.outcome;

    expect(outcome).toMatchObject({ ok: false, stopReason: "no_result" });
    // The stderr tail is what makes park-on-quota work for an ACP agent too.
    expect(session.stderrTail()).toContain("usage limit reached");
  });

  it("fails the run when the agent refuses the handshake", async () => {
    const { session } = drive({ failInitialize: "no credential configured" });
    const outcome = await session.outcome;
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("no credential configured");
    expect(await session.sessionId).toBeNull();
  });

  it("fails a turn the agent refused", async () => {
    const { session } = drive({ turns: [{ stopReason: "refusal", text: ["I won't"] }] });
    // A refusal is not a completed attempt: sending an untouched worktree to review as though
    // it were one would waste the reviewer's time.
    expect(await session.outcome).toMatchObject({ ok: false, stopReason: "refusal" });
  });
});
