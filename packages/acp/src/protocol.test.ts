import { describe, expect, it } from "bun:test";
import { toUpdates } from "./protocol.js";

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
