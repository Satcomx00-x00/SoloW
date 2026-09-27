/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import type { SessionEventPayload } from "@solow/contracts";
import { sessionRunLinks } from "./session-links.js";

/**
 * Which rows of a log count as evidence that a run *did* something outside this app.
 *
 * The classification of a URL is `@solow/core`'s and is tested there; what is tested here is the
 * reading of the log — that the merge request `glab` printed is found, and that a URL the
 * operator pasted into the brief is not mistaken for something the harness opened.
 */

const row = (payload: SessionEventPayload) => ({ kind: payload.kind, payload });

const MR = "https://gitlab.com/acme/gate/-/merge_requests/42";
const PIPELINE = "https://gitlab.com/acme/gate/-/pipelines/1204";

describe("sessionRunLinks", () => {
  it("finds the merge request a tool printed and the pipeline that followed it", () => {
    const links = sessionRunLinks([
      row({ kind: "tool_call", name: "Bash", callId: "c1", input: { command: "glab mr create" } }),
      row({ kind: "tool_result", callId: "c1", ok: true, output: `Created ${MR}` }),
      row({ kind: "tool_result", callId: "c2", ok: true, output: `Pipeline: ${PIPELINE}` }),
    ]);
    expect(links.map((l) => l.label)).toEqual(["Merge request !42", "Pipeline #1204"]);
    expect(links[0]?.url).toBe(MR);
  });

  it("reads a URL out of the command the run was asked to execute", () => {
    const links = sessionRunLinks([
      row({
        kind: "tool_call",
        name: "Bash",
        callId: "c1",
        input: { command: `glab mr view ${MR}` },
      }),
    ]);
    expect(links).toHaveLength(1);
  });

  it("takes the model's own report of what it opened", () => {
    const links = sessionRunLinks([
      row({ kind: "assistant_turn", text: `Opened ${MR} against main.`, thinking: false }),
    ]);
    expect(links.map((l) => l.kind)).toEqual(["merge_request"]);
  });

  it("takes the completion report, where a well-behaved harness names it", () => {
    const links = sessionRunLinks([
      row({
        kind: "widget",
        widgetId: "w1",
        widget: {
          kind: "task_complete",
          outcome: "changes_ready",
          summary: `Merge request: ${MR}`,
        },
      }),
    ]);
    expect(links).toHaveLength(1);
  });

  it("ignores the operator's own turn — a link in the brief is the ask, not something done", () => {
    expect(
      sessionRunLinks([row({ kind: "user_turn", text: `Pick up where ${MR} left off` })]),
    ).toEqual([]);
  });

  it("ignores thinking, which is not evidence that anything exists at the other end", () => {
    expect(
      sessionRunLinks([row({ kind: "assistant_turn", text: `maybe ${MR}`, thinking: true })]),
    ).toEqual([]);
  });

  it("says the same merge request once, however many times the run printed it", () => {
    const links = sessionRunLinks([
      row({ kind: "tool_result", callId: "c1", ok: true, output: MR }),
      row({ kind: "tool_result", callId: "c2", ok: true, output: `${MR}/diffs` }),
      row({ kind: "assistant_turn", text: `See ${MR}.`, thinking: false }),
    ]);
    expect(links).toHaveLength(1);
  });

  it("survives a log row from before the payload union existed", () => {
    expect(sessionRunLinks([{ kind: "stdout", payload: null }])).toEqual([]);
  });
});
