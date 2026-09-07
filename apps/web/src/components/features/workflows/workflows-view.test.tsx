/// <reference types="bun-types" />

import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import type { WorkflowStepDto, WorkflowWithStepsDto } from "@solow/contracts";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithTrpc } from "@/test/trpc-harness";
import { WorkflowsView } from "./workflows-view";

/**
 * The Workflow designer (issue #5 AC-1), drawn as a node graph.
 *
 * What is asserted is what the surface *sends*, not how it is drawn: the `+` beside a node has to
 * name the Step the new one follows and pick a harness without asking, a rename has to reach
 * `updateStep`. The drag arithmetic — which neighbour pair a drop turns into — is a pure function
 * with its own suite in `lib/workflow-canvas.test.ts`; React Flow's pointer machinery is not
 * something a DOM stand-in can drive, so it is not driven here.
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
    branch: null,
    mcpServerIds: [],
    skillIds: [],
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
    "profile.agent.list": () => ({
      items: [
        { id: "ap-1", name: "Opus" },
        { id: "ap-2", name: "Codex" },
      ],
      nextCursor: null,
    }),
    "library.mcp.list": () => [],
    "library.skill.list": () => [],
    ...overrides,
  };
}

beforeAll(() => {
  // React Flow measures nodes and the viewport with a ResizeObserver, which happy-dom does not
  // ship. A silent one is enough: nothing here asserts on geometry.
  if (typeof globalThis.ResizeObserver === "undefined") {
    class QuietResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    (globalThis as { ResizeObserver: unknown }).ResizeObserver = QuietResizeObserver;
  }
});

afterEach(cleanup);

/** The Step names as the canvas draws them, left to right. */
async function stepNames(): Promise<string[]> {
  const inputs = await screen.findAllByLabelText(/^Name of step \d+$/);
  return inputs.map((input) => (input as HTMLInputElement).value);
}

describe("WorkflowsView", () => {
  it("draws the selected workflow's steps in pipeline order", async () => {
    renderWithTrpc(<WorkflowsView />, handlersFor());

    expect(await stepNames()).toEqual(["Plan", "Implement", "Review"]);
  });

  it("adds a step after the one whose + was pressed, on the first harness profile, without asking", async () => {
    const { log } = renderWithTrpc(
      <WorkflowsView />,
      handlersFor({ "workflow.addStep": () => PIPELINE }),
    );

    // By label rather than by role: React Flow keeps a node `visibility: hidden` until it has
    // measured it, which needs the ResizeObserver the DOM stand-in lacks, and role queries skip
    // hidden elements. The button is there and clickable; it is only unmeasured. Enabled only
    // once the profile catalog has arrived — a `+` with no harness to give the Step is dimmed.
    const add = (await screen.findByLabelText("Add a step after Implement")) as HTMLButtonElement;
    await waitFor(() => expect(add.disabled).toBe(false));
    fireEvent.click(add);

    await waitFor(() => {
      const call = log.calls.find((c) => c.path === "workflow.addStep");
      expect(call?.input).toEqual({
        workflowId: "wf-1",
        name: "Step 4",
        agentProfileId: "ap-1",
        afterStepId: "s2",
      });
    });
  });

  it("puts a step at the head from the start pill, with a name no other step has", async () => {
    // The `+` on the Start edge is the one insert the Steps' own `+` cannot express. A null
    // `afterStepId` is the head; "Step 4" because 1–3 are taken, whatever order they sit in.
    const { log } = renderWithTrpc(
      <WorkflowsView />,
      handlersFor({
        "workflow.get": () => ({
          ...PIPELINE,
          steps: PIPELINE.steps.map((s, i) => ({ ...s, name: `Step ${i + 1}` })),
        }),
        "workflow.addStep": () => PIPELINE,
      }),
    );

    const add = (await screen.findByLabelText("Add a step at the start")) as HTMLButtonElement;
    await waitFor(() => expect(add.disabled).toBe(false));
    fireEvent.click(add);

    await waitFor(() => {
      const call = log.calls.find((c) => c.path === "workflow.addStep");
      expect(call?.input).toEqual({
        workflowId: "wf-1",
        name: "Step 4",
        agentProfileId: "ap-1",
        afterStepId: null,
      });
    });
  });

  it("renames a step in place, on blur, and sends nothing for an unchanged name", async () => {
    const { log } = renderWithTrpc(
      <WorkflowsView />,
      handlersFor({ "workflow.updateStep": () => PIPELINE }),
    );

    const name = await screen.findByLabelText("Name of step 1");
    fireEvent.blur(name);
    fireEvent.change(name, { target: { value: "Plan it out" } });
    fireEvent.blur(name);

    await waitFor(() => {
      const calls = log.calls.filter((c) => c.path === "workflow.updateStep");
      expect(calls).toHaveLength(1);
      expect(calls[0]?.input).toEqual({ stepId: "s1", name: "Plan it out" });
    });
  });

  it("turns a branch on with both exits pointing where the step already went", async () => {
    // So that switching the branch on changes nothing until a target is chosen: the default is
    // the rank successor on both sides, and a placeholder question the operator will replace.
    const { log } = renderWithTrpc(
      <WorkflowsView />,
      handlersFor({ "workflow.updateStep": () => PIPELINE }),
    );

    fireEvent.click(await screen.findByLabelText("Branch Implement on a condition"));

    await waitFor(() => {
      const call = log.calls.find((c) => c.path === "workflow.updateStep");
      expect(call?.input).toEqual({
        stepId: "s2",
        branch: {
          when: { kind: "agent-decides", question: "Is the condition met?" },
          thenStepId: "s3",
          elseStepId: "s3",
        },
      });
    });
  });

  it("draws a branching step with its condition and its two exits, and lets the branch go", async () => {
    const branched: WorkflowWithStepsDto = {
      ...PIPELINE,
      steps: PIPELINE.steps.map((s) =>
        s.id === "s3"
          ? {
              ...s,
              branch: {
                when: { kind: "agent-decides", question: "Does it need another pass?" },
                thenStepId: "s2",
                elseStepId: null,
              },
            }
          : s,
      ),
    };
    const { log } = renderWithTrpc(
      <WorkflowsView />,
      handlersFor({ "workflow.get": () => branched, "workflow.updateStep": () => PIPELINE }),
    );

    const question = (await screen.findByLabelText(
      "Question the harness answers",
    )) as HTMLTextAreaElement;
    expect(question.value).toBe("Does it need another pass?");
    // Exactly one Step branches, so exactly one pair of targets is on offer.
    expect(screen.getAllByText("If yes")).toHaveLength(1);
    expect(screen.getAllByText("If no")).toHaveLength(1);

    fireEvent.click(screen.getByLabelText("Remove the branch of Review"));
    await waitFor(() => {
      const call = log.calls.find((c) => c.path === "workflow.updateStep");
      expect(call?.input).toEqual({ stepId: "s3", branch: null });
    });
  });

  it("says on the node, in words, why a step cannot run as the graph stands", async () => {
    // Plan branches past Implement on both exits: Implement is unreachable. Review still leads
    // to the end, so nothing is trapped — exactly one node carries exactly one warning.
    const skipping: WorkflowWithStepsDto = {
      ...PIPELINE,
      steps: PIPELINE.steps.map((s) =>
        s.id === "s1"
          ? {
              ...s,
              branch: {
                when: { kind: "agent-decides", question: "Skip implementation?" },
                thenStepId: "s3",
                elseStepId: "s3",
              },
            }
          : s,
      ),
    };
    renderWithTrpc(<WorkflowsView />, handlersFor({ "workflow.get": () => skipping }));

    const list = await screen.findByLabelText("Problems with Implement");
    expect(list.textContent).toContain("Unreachable — no step leads here, so it never runs.");
    expect(screen.queryByLabelText("Problems with Plan")).toBeNull();
    expect(screen.queryByLabelText("Problems with Review")).toBeNull();
  });

  it("lets a step pick a library item from a searchable dropdown, and locks the ones every harness loads", async () => {
    const { log } = renderWithTrpc(
      <WorkflowsView />,
      handlersFor({
        "library.mcp.list": () => [
          {
            id: "m1",
            name: "github",
            description: null,
            transport: { kind: "http", url: "https://x.example/mcp", headers: {} },
            enabled: false,
            createdAt: AT,
            updatedAt: AT,
          },
          {
            id: "m2",
            name: "docs",
            description: null,
            transport: { kind: "http", url: "https://d.example/mcp", headers: {} },
            enabled: true,
            createdAt: AT,
            updatedAt: AT,
          },
        ],
        "workflow.updateStep": () => PIPELINE,
      }),
    );

    // The picker reads the choice back on its trigger before it is opened: the Workspace-wide
    // server is what every Step loads, so it is the whole summary on a Step that chose nothing.
    const trigger = await screen.findByLabelText("MCP servers for Implement");
    expect(trigger.textContent).toContain("docs");
    expect(trigger.textContent).not.toContain("github");

    // Opened, the Workspace-wide one is checked and locked; the other is this Step's to choose.
    fireEvent.click(trigger);
    const locked = (await screen.findByLabelText("Load docs in Implement")) as HTMLButtonElement;
    expect(locked.getAttribute("data-state")).toBe("checked");
    expect(locked.disabled).toBe(true);

    fireEvent.click(screen.getByLabelText("Load github in Implement"));
    await waitFor(() => {
      const call = log.calls.find((c) => c.path === "workflow.updateStep");
      expect(call?.input).toEqual({ stepId: "s2", mcpServerIds: ["m1"] });
    });
  });

  it("offers the first step from the empty canvas itself", async () => {
    const { log } = renderWithTrpc(
      <WorkflowsView />,
      handlersFor({
        "workflow.get": () => ({ ...PIPELINE, steps: [], stepCount: 0 }),
        "workflow.addStep": () => PIPELINE,
      }),
    );

    fireEvent.click(await screen.findByRole("button", { name: "Add the first step" }));

    await waitFor(() => {
      const call = log.calls.find((c) => c.path === "workflow.addStep");
      expect(call?.input).toEqual({ workflowId: "wf-1", name: "Step 1", agentProfileId: "ap-1" });
    });
  });

  it("refuses to add a step when there is no harness profile to give it", async () => {
    renderWithTrpc(
      <WorkflowsView />,
      handlersFor({
        "workflow.get": () => ({ ...PIPELINE, steps: [], stepCount: 0 }),
        "profile.agent.list": () => ({ items: [], nextCursor: null }),
      }),
    );

    const button = await screen.findByRole("button", { name: "Add the first step" });
    await waitFor(() => expect(button.hasAttribute("disabled")).toBe(true));
    expect(await screen.findByText(/Create a harness profile first/)).toBeTruthy();
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

  it("names the harness profile each step runs under, from the profile catalog", async () => {
    renderWithTrpc(<WorkflowsView />, handlersFor());

    // One `Harness profile` control per step, and no add-step form to carry a fourth.
    const labels = await screen.findAllByText("Harness profile");
    expect(labels).toHaveLength(3);
  });

  it("shows a WIP badge, because the run's live position on the graph is not drawn yet", async () => {
    renderWithTrpc(<WorkflowsView />, handlersFor());

    expect(await screen.findByText("WIP")).toBeTruthy();
  });
});
