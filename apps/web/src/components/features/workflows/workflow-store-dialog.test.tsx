/// <reference types="bun-types" />

import { afterEach, describe, expect, it, mock } from "bun:test";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithTrpc } from "@/test/trpc-harness";
import { WorkflowStoreDialog } from "./workflow-store-dialog";

/**
 * The store, from the surface's side: the catalog is `@solow/core`'s suite; what is proved here
 * is that a click sends the entry and the chosen profile, that the reply refreshes both lists,
 * and that a pipeline already in the Workspace is marked without being made uninstallable.
 */

const AT = "2026-08-20T00:00:00.000Z";
const pushed: string[] = [];

mock.module("next/navigation", () => ({
  useRouter: () => ({
    push: (href: string) => pushed.push(href),
    replace: () => {},
    refresh: () => {},
  }),
}));

afterEach(() => {
  cleanup();
  pushed.length = 0;
});

const installedWorkflow = (name: string) => ({
  id: "wf-1",
  name,
  description: null,
  version: 1,
  stepCount: 3,
  createdAt: AT,
  updatedAt: AT,
});

describe("WorkflowStoreDialog", () => {
  it("installs an entry on the first profile by default, then opens the pipeline", async () => {
    const { log } = renderWithTrpc(
      <WorkflowStoreDialog
        trigger={<button type="button">Browse the store</button>}
        installed={[]}
      />,
      {
        "profile.agent.list": () => ({
          items: [
            { id: "ap-2", name: "Opus" },
            { id: "ap-1", name: "Codex" },
          ],
          nextCursor: null,
        }),
        "workflow.installFromStore": () => ({
          workflow: { ...installedWorkflow("Security review"), steps: [] },
          createdSkills: ["security-review-checklist"],
          reusedSkills: [],
        }),
        "workflow.list": () => [],
        "library.skill.list": () => [],
      },
    );

    fireEvent.click(screen.getByRole("button", { name: "Browse the store" }));
    fireEvent.change(await screen.findByLabelText("Search the store"), {
      target: { value: "security" },
    });
    // The category filter narrows the same list.
    fireEvent.click(screen.getByRole("button", { name: "Review" }));
    expect(screen.getByText("Security review")).toBeTruthy();
    expect(screen.queryByText("Hotfix")).toBeNull();

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Install Security review" })).not.toHaveProperty(
        "disabled",
        true,
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Install Security review" }));

    await waitFor(() => {
      const call = log.calls.find((c) => c.path === "workflow.installFromStore");
      expect(call?.input).toEqual({ entryId: "security-review", harnessProfileId: "ap-2" });
    });
    await waitFor(() => expect(pushed).toContain("/workflows/wf-1"));
  });

  it("marks an entry the Workspace already has, and still lets it be installed again", async () => {
    renderWithTrpc(
      <WorkflowStoreDialog
        trigger={<button type="button">Browse the store</button>}
        installed={[installedWorkflow("hotfix")]}
      />,
      {
        "profile.agent.list": () => ({ items: [{ id: "ap-1", name: "Codex" }], nextCursor: null }),
      },
    );

    fireEvent.click(screen.getByRole("button", { name: "Browse the store" }));
    fireEvent.click(await screen.findByRole("button", { name: "Bug fix" }));
    expect(screen.getByText("Installed")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Install Hotfix" }).textContent).toBe(
      "Install again",
    );
  });

  it("finds an entry by the name of one of its steps, and shows the server's refusal on the card", async () => {
    renderWithTrpc(
      <WorkflowStoreDialog
        trigger={<button type="button">Browse the store</button>}
        installed={[]}
      />,
      {
        "profile.agent.list": () => ({ items: [{ id: "ap-1", name: "Codex" }], nextCursor: null }),
        "workflow.installFromStore": () => {
          throw new Error("WORKFLOW_NO_HARNESS_PROFILE");
        },
      },
    );

    fireEvent.click(screen.getByRole("button", { name: "Browse the store" }));
    fireEvent.change(await screen.findByLabelText("Search the store"), {
      target: { value: "characterise" },
    });
    expect(screen.getByText("Refactor safely")).toBeTruthy();
    expect(screen.queryByText("Hotfix")).toBeNull();

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Install Refactor safely" })).not.toHaveProperty(
        "disabled",
        true,
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Install Refactor safely" }));
    expect((await screen.findByRole("alert")).textContent).toContain("WORKFLOW_NO_HARNESS_PROFILE");
    expect(pushed).not.toContain("/workflows/wf-1");
  });

  it("cannot install with no harness profile to run on", async () => {
    renderWithTrpc(
      <WorkflowStoreDialog
        trigger={<button type="button">Browse the store</button>}
        installed={[]}
      />,
      { "profile.agent.list": () => ({ items: [], nextCursor: null }) },
    );

    fireEvent.click(screen.getByRole("button", { name: "Browse the store" }));
    fireEvent.click(await screen.findByRole("button", { name: "Methods" }));
    const install = screen.getByRole("button", {
      name: "Install Spec Kit — spec-driven development",
    });
    expect(install).toHaveProperty("disabled", true);
  });
});
