import { describe, expect, it } from "bun:test";
import { advertisedOptions, sessionNewResultSchema, toUpdates } from "./protocol.js";

/**
 * Flattening `session/update` notifications. The rule under test throughout: an agent on its own
 * release cadence may say something this build has never heard of, and the answer must be
 * silence rather than a thrown run.
 */

const notification = (update: Record<string, unknown>) => ({ sessionId: "s1", update });

describe("toUpdates", () => {
  it("routes each message chunk to the channel it came from", () => {
    expect(
      toUpdates(
        notification({
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "hi" },
        }),
      ),
    ).toEqual([{ kind: "text", channel: "assistant", text: "hi" }]);

    expect(
      toUpdates(
        notification({
          sessionUpdate: "agent_thought_chunk",
          content: { type: "text", text: "considering" },
        }),
      ),
    ).toEqual([{ kind: "text", channel: "thinking", text: "considering" }]);

    expect(
      toUpdates(
        notification({
          sessionUpdate: "user_message_chunk",
          content: { type: "text", text: "keep going" },
        }),
      ),
    ).toEqual([{ kind: "text", channel: "user", text: "keep going" }]);
  });

  it("drops a non-text content block rather than stringifying it", () => {
    // A terminal showing `[object Object]` is worse than a terminal showing nothing.
    expect(
      toUpdates(
        notification({
          sessionUpdate: "agent_message_chunk",
          content: { type: "image", data: "…", mimeType: "image/png" },
        }),
      ),
    ).toEqual([]);
  });

  it("reports a tool call by its title, and never by its raw input", () => {
    const updates = toUpdates(
      notification({
        sessionUpdate: "tool_call",
        toolCallId: "call-1",
        title: "Edit src/latch.ts",
        kind: "edit",
        status: "in_progress",
        rawInput: { path: "/etc/shadow", content: "sk-secret" },
      }),
    );
    expect(updates).toEqual([
      { kind: "tool_call", name: "Edit src/latch.ts", toolCallId: "call-1", status: "in_progress" },
    ]);
    expect(JSON.stringify(updates)).not.toContain("sk-secret");
  });

  it("treats a tool_call_update the same as the call it updates", () => {
    expect(
      toUpdates(
        notification({
          sessionUpdate: "tool_call_update",
          toolCallId: "call-1",
          status: "completed",
        }),
      ),
    ).toEqual([{ kind: "tool_call", name: "tool", toolCallId: "call-1", status: "completed" }]);
  });

  it("surfaces a mode change", () => {
    expect(
      toUpdates(notification({ sessionUpdate: "current_mode_update", currentModeId: "plan" })),
    ).toEqual([{ kind: "mode", modeId: "plan" }]);
  });

  it("says nothing about an update kind this build has never heard of", () => {
    expect(toUpdates(notification({ sessionUpdate: "quantum_entanglement_report" }))).toEqual([]);
    expect(toUpdates({ nonsense: true })).toEqual([]);
    expect(toUpdates(null)).toEqual([]);
  });
});

/**
 * What an agent offers, from whichever shape it said it in (2026-08-28).
 *
 * Read against the wire, not the spec: opencode 1.18 answers `session/new` with a `configOptions`
 * array and no `models`/`modes` keys whatsoever. SoloW read only the spec-shaped keys, so 362
 * models and 3 modes arrived as "advertises nothing" — the capability cache stayed empty forever
 * and every Profile picker for it had nothing to suggest.
 */
describe("advertisedOptions", () => {
  it("reads the spec-shaped keys", () => {
    const created = sessionNewResultSchema.parse({
      sessionId: "s1",
      models: { availableModels: [{ modelId: "opus" }, { modelId: "sonnet" }] },
      modes: { availableModes: [{ id: "plan", name: "Plan" }] },
    });

    expect(advertisedOptions(created)).toEqual({ models: ["opus", "sonnet"], modes: ["plan"] });
  });

  it("reads configOptions, which is where opencode actually puts them", () => {
    const created = sessionNewResultSchema.parse({
      sessionId: "s1",
      configOptions: [
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "opencode/big-pickle",
          options: [{ value: "openrouter/auto", name: "Auto" }],
        },
        {
          id: "mode",
          category: "mode",
          type: "select",
          currentValue: "orchestrator",
          options: [{ value: "build" }, { value: "plan" }],
        },
      ],
    });

    expect(advertisedOptions(created)).toEqual({
      models: ["openrouter/auto"],
      modes: ["build", "plan"],
    });
  });

  it("merges both shapes without repeating an id", () => {
    // An agent may grow the spec-shaped keys in a later release while still sending the other.
    // Preferring one would make SoloW's answer depend on the wire format rather than the agent.
    const created = sessionNewResultSchema.parse({
      sessionId: "s1",
      models: { availableModels: [{ modelId: "opus" }] },
      configOptions: [{ id: "model", category: "model", options: [{ value: "opus" }] }],
    });

    expect(advertisedOptions(created)).toEqual({ models: ["opus"], modes: [] });
  });

  it("says nothing for an agent that advertises nothing, rather than guessing", () => {
    // The guard the pins rely on: no advertised list means neither `session/set_mode` nor
    // `session/set_model` is ever sent, so an agent that supports neither is never spoken to
    // in a vocabulary it does not have.
    const created = sessionNewResultSchema.parse({ sessionId: "s1" });

    expect(advertisedOptions(created)).toEqual({ models: [], modes: [] });
  });
});
