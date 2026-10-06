/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import type { TaskWorkflowBindingDto } from "@solow/contracts";
import { cleanup, render, screen } from "@testing-library/react";
import { type StepScope, WorkflowPosition } from "./workflow-steps";

/**
 * The Task header's statement of where the run is. Only the position now: the Steps themselves
 * are the board's nodes, and a second row of the same Steps in the header was removed.
 */

function scope(over: Partial<StepScope> = {}): StepScope {
  const steps = ["Specify", "Clarify", "Plan"].map((name, i) => ({
    step: { id: `st-${i + 1}`, name } as never,
    status: (i === 0 ? "done" : i === 1 ? "running" : "upcoming") as never,
    current: i === 1,
  }));
  return {
    binding: { workflowName: "Spec Kit — spec-driven development" } as TaskWorkflowBindingDto,
    stepped: steps,
    selected: "st-2",
    select: () => {},
    settled: true,
    ...over,
  };
}

afterEach(cleanup);

describe("WorkflowPosition", () => {
  it("names the Workflow and the Step the run is on", () => {
    render(<WorkflowPosition scope={scope()} />);

    const region = screen.getByRole("region", { name: "Workflow progress" });
    expect(region.textContent).toContain("Spec Kit — spec-driven development");
    expect(region.textContent).toContain("Step 2 of 3");
  });

  it("draws no Step tabs — the board is where the Steps are", () => {
    render(<WorkflowPosition scope={scope()} />);

    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByRole("tab")).toBeNull();
  });

  it("renders nothing for a Task on no Workflow", () => {
    const { container } = render(<WorkflowPosition scope={scope({ binding: null })} />);

    expect(container.textContent).toBe("");
  });
});
