/// <reference types="bun-types" />

import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithTrpc } from "@/test/trpc-harness";

/**
 * The Workflows page's own header controls: the three ways a pipeline comes into being, which
 * used to be a create form folded into the sidebar.
 *
 * `next/navigation` is stubbed completely, for the reason `board.test.tsx` gives.
 */
const pushed: string[] = [];
mock.module("next/navigation", () => ({
  useRouter: () => ({
    push: (href: string) => pushed.push(href),
    replace: () => {},
    refresh: () => {},
  }),
  usePathname: () => "/workflows",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
}));

const { WorkflowCreateActions } = await import("./workflow-create-actions");

afterEach(() => {
  cleanup();
  pushed.length = 0;
});

describe("WorkflowCreateActions", () => {
  it("offers the store, an import and a new workflow, side by side", () => {
    renderWithTrpc(<WorkflowCreateActions installed={[]} />, {});

    expect(screen.getByRole("button", { name: "Store" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Import" })).toBeDefined();
    expect(screen.getByRole("button", { name: "New workflow" })).toBeDefined();
  });

  it("creates a workflow from a name and opens it on the canvas", async () => {
    const { log } = renderWithTrpc(<WorkflowCreateActions installed={[]} />, {
      "workflow.create": (input) => ({ id: "wf-new", ...(input as object) }),
      "workflow.list": () => [],
    });

    fireEvent.click(screen.getByRole("button", { name: "New workflow" }));
    const name = await screen.findByRole("textbox", { name: "Workflow name" });
    fireEvent.change(name, { target: { value: "Plan, build, review" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(pushed).toEqual(["/workflows/wf-new"]));
    expect(log.calls.find((c) => c.path === "workflow.create")?.input).toEqual({
      name: "Plan, build, review",
    });
  });

  it("will not create a workflow with no name", async () => {
    renderWithTrpc(<WorkflowCreateActions installed={[]} />, {});

    fireEvent.click(screen.getByRole("button", { name: "New workflow" }));
    await screen.findByRole("textbox", { name: "Workflow name" });
    expect((screen.getByRole("button", { name: "Create" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("says why when the server refuses the name", async () => {
    renderWithTrpc(<WorkflowCreateActions installed={[]} />, {
      "workflow.create": () => {
        throw new Error("A workflow with that name already exists");
      },
    });

    fireEvent.click(screen.getByRole("button", { name: "New workflow" }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Workflow name" }), {
      target: { value: "Bug fix" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    expect((await screen.findByRole("alert")).textContent).toContain("already exists");
    expect(pushed).toEqual([]);
  });
});
