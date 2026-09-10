/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import type { WorkflowStepBranch, WorkflowStepDto } from "@solow/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { BranchFields } from "./workflow-canvas";

/**
 * The branch editor's one rule about time: two edits made before the first one's refresh lands
 * must both reach the server. Every save carries the whole branch, so the second has to merge
 * into what the first sent — not into the prop, which still says what the row said before.
 */

const AT = "2026-08-20T00:00:00.000Z";
const step = (branch: WorkflowStepBranch): WorkflowStepDto => ({
  id: "st-implement",
  workflowId: "wf-1",
  name: "Implement",
  position: 0,
  rank: "1",
  agentProfileId: "ap-1",
  promptTemplate: "",
  gate: "auto",
  advanceOn: "agent-signal",
  onEnter: null,
  branch,
  mcpServerIds: [],
  skillIds: [],
  permissionMode: null,
  createdAt: AT,
  updatedAt: AT,
});
const siblings = [
  { id: "st-implement", name: "Implement" },
  { id: "st-review", name: "Review" },
];

afterEach(cleanup);

describe("BranchFields", () => {
  it("merges a second edit into the first one it sent, not into the stale prop", async () => {
    const saved: (WorkflowStepBranch | null)[] = [];
    // The row as the server holds it: the branch a Step is born with.
    const born: WorkflowStepBranch = {
      when: { kind: "agent-decides", question: "Is the condition met?" },
      thenStepId: "st-review",
      elseStepId: "st-review",
    };
    render(<BranchFields step={step(born)} siblings={siblings} save={(b) => saved.push(b)} />);

    fireEvent.click(screen.getByRole("combobox", { name: "Condition" }));
    fireEvent.click(await screen.findByRole("option", { name: "Step produced changes" }));
    // No re-render with the refreshed row in between — the operator is already on the next field.
    fireEvent.click(screen.getByRole("combobox", { name: "If no" }));
    fireEvent.click(await screen.findByRole("option", { name: "End of pipeline" }));

    expect(saved).toEqual([
      { when: { kind: "produced-changes" }, thenStepId: "st-review", elseStepId: "st-review" },
      { when: { kind: "produced-changes" }, thenStepId: "st-review", elseStepId: null },
    ]);
  });

  it("takes the refreshed row as its base once it arrives", async () => {
    const saved: (WorkflowStepBranch | null)[] = [];
    const first: WorkflowStepBranch = {
      when: { kind: "produced-changes" },
      thenStepId: "st-review",
      elseStepId: null,
    };
    const { rerender } = render(
      <BranchFields step={step(first)} siblings={siblings} save={(b) => saved.push(b)} />,
    );
    // The server answered with an edit made elsewhere; the next save builds on that.
    const refreshed: WorkflowStepBranch = { ...first, when: { kind: "outcome", is: "blocked" } };
    rerender(
      <BranchFields step={step(refreshed)} siblings={siblings} save={(b) => saved.push(b)} />,
    );

    fireEvent.click(screen.getByRole("combobox", { name: "If yes" }));
    fireEvent.click(await screen.findByRole("option", { name: "End of pipeline" }));
    expect(saved).toEqual([
      { when: { kind: "outcome", is: "blocked" }, thenStepId: null, elseStepId: null },
    ]);
  });
});
