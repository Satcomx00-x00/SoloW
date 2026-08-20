/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import type { WorkflowStepDto, WorkflowWithStepsDto } from "@gatecontrol/contracts";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithTrpc } from "@/test/trpc-harness";
import { WorkflowsView } from "./workflows-view";

/**
 * The Workflow editor (issue #5 AC-1).
 *
 * What is asserted is what the surface *sends*, not how it looks: a Move up has to name the two
 * Steps the moved one lands between, because that is the contract the server checks for staleness
 * — a button that sent a position would be describing a list nobody is looking at any more.
 */

const AT = "2026-08-20T00:00:00.000Z";

function step(id: string, name: string, position: number, rank: string): WorkflowStepDto {
  return {
    id,
    workflowId: "wf-1",
    name,
    position,
    rank,
    agentProfileId: "ap-1",
    promptTemplate: `${name} it.`,
    gate: "human",
    advanceOn: "review",
    onEnter: null,
    createdAt: AT,
    updatedAt: AT,
  };
}

const PIPELINE: WorkflowWithStepsDto = {
  id: "wf-1",
  name: "Plan, build, review",
  description: null,
  version: 4,
  stepCount: 3,
  steps: [
    step("s1", "Plan", 0, "1"),
    step("s2", "Implement", 1, "2"),
    step("s3", "Review", 2, "3"),
  ],
  createdAt: AT,
  updatedAt: AT,
};

function handlersFor(overrides: Record<string, (input: unknown) => unknown> = {}) {
  return {
    "workflow.list": () => [
      {
        id: "wf-1",
        name: PIPELINE.name,
        description: null,
        version: 4,
        stepCount: 3,
        createdAt: AT,
        updatedAt: AT,
      },
    ],
    "workflow.get": () => PIPELINE,
    "profile.agent.list": () => [
      { id: "ap-1", name: "Opus" },
      { id: "ap-2", name: "Codex" },
    ],
    ...overrides,
  };
}

afterEach(cleanup);

describe("WorkflowsView", () => {
  it("renders the selected workflow's steps in pipeline order", async () => {
    renderWithTrpc(<WorkflowsView />, handlersFor());

    const list = await screen.findByRole("list", { name: "Steps of Plan, build, review" });
    const names = Array.from(list.querySelectorAll("li")).map((li) =>
      li.textContent?.replace(/\s+/g, " ").trim(),
    );
    expect(names[0]).toMatch(/^1\.\s*Plan/);
    expect(names[1]).toMatch(/^2\.\s*Implement/);
    expect(names[2]).toMatch(/^3\.\s*Review/);
  });

  it("sends the two neighbours a step lands between when it is moved up", async () => {
    const { log } = renderWithTrpc(<WorkflowsView />, handlersFor());

    fireEvent.click(await screen.findByRole("button", { name: "Move Review up" }));

    await waitFor(() => {
      const call = log.calls.find((c) => c.path === "workflow.reorderStep");
      expect(call).toBeDefined();
      // Review moves above Implement: it lands after Plan and before Implement.
      expect(call?.input).toEqual({
        stepId: "s3",
        afterStepId: "s1",
        beforeStepId: "s2",
      });
    });
  });

  it("sends nulls for the ends of the list", async () => {
    const { log } = renderWithTrpc(<WorkflowsView />, handlersFor());

    fireEvent.click(await screen.findByRole("button", { name: "Move Implement up" }));
    await waitFor(() => {
      const call = log.calls.find((c) => c.path === "workflow.reorderStep");
      expect(call?.input).toEqual({ stepId: "s2", afterStepId: null, beforeStepId: "s1" });
    });

    cleanup();
    const second = renderWithTrpc(<WorkflowsView />, handlersFor());
    fireEvent.click(await screen.findByRole("button", { name: "Move Implement down" }));
    await waitFor(() => {
      const call = second.log.calls.find((c) => c.path === "workflow.reorderStep");
      expect(call?.input).toEqual({ stepId: "s2", afterStepId: "s3", beforeStepId: null });
    });
  });

  it("offers no move that would fall off either end of the list", async () => {
    renderWithTrpc(<WorkflowsView />, handlersFor());

    const up = await screen.findByRole("button", { name: "Move Plan up" });
    const down = await screen.findByRole("button", { name: "Move Review down" });
    expect(up.hasAttribute("disabled")).toBe(true);
    expect(down.hasAttribute("disabled")).toBe(true);
  });

  it("tells a workspace with the flag off how to enable it, rather than showing an empty list", async () => {
    renderWithTrpc(
      <WorkflowsView />,
      handlersFor({
        "workflow.list": () => {
          throw new Error("FLAG_DISABLED");
        },
      }),
    );

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("bun run flag enable ff-workflows");
    expect(screen.queryByRole("list", { name: "Workflows" })).toBeNull();
  });

  it("names the agent profile each step runs under, from the profile catalog", async () => {
    renderWithTrpc(<WorkflowsView />, handlersFor());

    // One `Agent profile` control per step plus the add-step form's own.
    const labels = await screen.findAllByText("Agent profile");
    expect(labels).toHaveLength(4);
  });

  it("shows a WIP badge, because advancing a Task through Steps has no run loop behind it yet", async () => {
    renderWithTrpc(<WorkflowsView />, handlersFor());

    expect(await screen.findByText("WIP")).toBeTruthy();
  });
});
