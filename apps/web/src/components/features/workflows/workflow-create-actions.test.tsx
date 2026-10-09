/// <reference types="bun-types" />

import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithTrpc } from "@/test/trpc-harness";
import { trpc } from "@/trpc/react";

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

  it("lists the new workflow even when the list's first read was still in flight", async () => {
    // Create pressed moments after the page opened (the control check does exactly this): the
    // list's first read began before the write, so it answers without the new pipeline — and the
    // canvas, which picks its Workflow out of the list, opened on "No workflows yet".
    const created = { id: "wf-new", name: "Plan, build, review", stepCount: 0 };
    let reads = 0;
    function ListedNames() {
      const list = trpc.workflow.list.useQuery({});
      return <p data-testid="listed">{(list.data ?? []).map((w) => w.name).join(",")}</p>;
    }
    renderWithTrpc(
      <>
        <ListedNames />
        <WorkflowCreateActions installed={[]} />
      </>,
      {
        "workflow.list": () =>
          reads++ === 0 ? new Promise((resolve) => setTimeout(() => resolve([]), 300)) : [created],
        "workflow.create": () => created,
      },
    );

    fireEvent.click(screen.getByRole("button", { name: "New workflow" }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Workflow name" }), {
      target: { value: created.name },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(screen.getByTestId("listed").textContent).toBe(created.name));
    // And the stale first answer, landing afterwards, does not take it away again.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(screen.getByTestId("listed").textContent).toBe(created.name);
    expect(pushed).toEqual(["/workflows/wf-new"]);
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
        throw new Error("VALIDATION_FAILED");
      },
    });

    fireEvent.click(screen.getByRole("button", { name: "New workflow" }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Workflow name" }), {
      target: { value: "Bug fix" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Check the fields");
    expect(alert.textContent).not.toContain("VALIDATION_FAILED");
    expect(pushed).toEqual([]);
  });
});
