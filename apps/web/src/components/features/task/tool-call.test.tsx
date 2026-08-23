/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, render, screen, within } from "@testing-library/react";
import { ToolCall } from "./tool-call";
import type { ToolRow } from "./transcript";

/**
 * A tool call rendered as a tool call (issue #2). These assert the four things the old
 * `tool: Read` line could not do: name what ran and on what, end in a state a reader can see,
 * stay out of the way until asked, and admit what it is not showing.
 */

afterEach(cleanup);

const toolRow = (over: Partial<ToolRow> = {}): ToolRow => ({
  kind: "tool",
  id: "sess-1:4",
  sessionId: "sess-1",
  seq: 4,
  name: "Read",
  callId: "c1",
  input: { file_path: "src/latch.ts" },
  status: "completed",
  result: { ok: true, output: "export const latch = true;\n", truncated: false },
  ...over,
});

describe("ToolCall", () => {
  it("names the tool and the argument that identifies the call, without opening", () => {
    // The summary is the only line most of these rows will ever show, so it has to be enough on
    // its own to tell one Read from the ninety-nine others in the run.
    const { container } = render(<ToolCall row={toolRow()} />);

    const summary = container.querySelector("summary") as HTMLElement;
    expect(within(summary).getByText("Read")).toBeDefined();
    expect(within(summary).getByText("src/latch.ts")).toBeDefined();
  });

  it("keeps the arguments and the result collapsed by default", () => {
    // A run makes hundreds of these; expanded, they are the wall of output this view replaces.
    const { container } = render(<ToolCall row={toolRow()} />);

    const details = container.querySelector("details") as HTMLDetailsElement;
    expect(details.open).toBe(false);
    // …and the body is genuinely behind the disclosure rather than beside it.
    expect(details.contains(screen.getByText("file_path"))).toBe(true);
    expect(details.contains(screen.getByText(/export const latch/))).toBe(true);
  });

  it("reads as failed at a glance when the tool failed", () => {
    const { container } = render(
      <ToolCall
        row={toolRow({
          name: "Bash",
          input: { command: "bun test" },
          status: "failed",
          result: { ok: false, output: "1 test failed", truncated: false },
        })}
      />,
    );

    const details = container.querySelector("[data-tool-call]") as HTMLElement;
    expect(details.getAttribute("data-tool-status")).toBe("failed");
    // Tinted with the same token the board uses for a failed Task, and never colour alone: the
    // pill and the result heading both say the word.
    expect(details.className).toContain("state-failed");
    expect(screen.getAllByText("Failed").length).toBe(2);
  });

  it("says the producer recorded no arguments rather than showing an empty box", () => {
    // A real state: the orchestrator's allowlist yields nothing for an unknown tool, and ACP
    // never exposes tool input at all.
    render(<ToolCall row={toolRow({ input: null })} />);
    expect(screen.getByText("No arguments recorded.")).toBeDefined();
  });

  it("states that an output was cut, so nobody reads the head as the whole", () => {
    render(
      <ToolCall
        row={toolRow({ result: { ok: true, output: "line 1\nline 2", truncated: true } })}
      />,
    );
    expect(screen.getByText(/Output truncated/)).toBeDefined();
  });

  it("shows how far a call has got while it is still running", () => {
    render(<ToolCall row={toolRow({ status: "in_progress", result: null })} />);

    expect(screen.getByText("Running")).toBeDefined();
    expect(screen.getByText("No result recorded yet.")).toBeDefined();
  });

  it("carries no status pill when the producer reported no status", () => {
    // Claude Code's adapter reports a call with no status at all; an invented one would be a
    // claim the transcript cannot make.
    render(<ToolCall row={toolRow({ status: null, result: null })} />);

    for (const label of ["Pending", "Running", "Completed", "Failed"]) {
      expect(screen.queryByText(label)).toBeNull();
    }
  });
});
