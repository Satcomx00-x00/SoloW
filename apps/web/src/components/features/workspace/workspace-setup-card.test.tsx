/// <reference types="bun-types" />
import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithTrpc } from "@/test/trpc-harness";
import { WorkspaceSetupCard } from "./workspace-setup-card";

/**
 * The checklist that replaced the fixture (2026-08-28).
 *
 * A local install used to arrive holding two invented companies, each already carrying a
 * credential, an Agent Profile, an Executor and a repository that never existed — so the product
 * looked configured on first launch, and the real gap stayed hidden until a Task refused to run.
 * These assert the two properties that make the replacement honest: it says what is missing, and
 * it goes away by itself once nothing is.
 */

// Every other client suite here does this explicitly: there is no global auto-cleanup under
// the bun runner, so without it each render stacks on the last and queries match the wrong one.
afterEach(cleanup);

const setup = (over: Record<string, unknown> = {}) => ({
  workspace: { id: "ws-1", name: "My workspace", createdAt: "2026-08-01T00:00:00.000Z" },
  steps: [
    { key: "workspace", done: true, detail: "My workspace", blockedBy: null },
    { key: "agents", done: true, detail: "2 agents", blockedBy: null },
    { key: "secret", done: false, detail: "", blockedBy: null },
    { key: "agent-profile", done: false, detail: "", blockedBy: "secret" },
    { key: "executor", done: false, detail: "", blockedBy: null },
    { key: "repository", done: false, detail: "", blockedBy: null },
    { key: "core-loop", done: false, detail: "", blockedBy: null },
  ],
  ready: false,
  ...over,
});

describe("WorkspaceSetupCard", () => {
  it("shows how far along the workspace is, and what is still missing", async () => {
    renderWithTrpc(<WorkspaceSetupCard />, { "workspace.setup": () => setup() });

    expect(await screen.findByText("2/7")).toBeDefined();
    expect(screen.getByRole("link", { name: "Add a secret" })).toBeDefined();
    expect(screen.getByRole("link", { name: "Create an executor" })).toBeDefined();
  });

  it("names what a blocked step is waiting on instead of offering a dead action", async () => {
    // An Agent Profile binds an agent to a Secret; opening that form first would show an empty
    // picker, which is a worse answer than a sentence saying why not yet.
    renderWithTrpc(<WorkspaceSetupCard />, { "workspace.setup": () => setup() });

    expect(await screen.findByText("Needs a credential first")).toBeDefined();
    expect(screen.queryByRole("link", { name: "Create a profile" })).toBeNull();
  });

  it("offers the core loop as a switch, not an errand to another screen", async () => {
    // `ff-core-program` ships OFF and every flag-gated procedure requires it, so this is the one
    // step whose action is a single boolean — sending someone to the flags table to flip it is
    // how a checklist turns into a list of chores.
    const flagged: unknown[] = [];
    renderWithTrpc(<WorkspaceSetupCard />, {
      "workspace.setup": () => setup(),
      "flag.set": (input) => {
        flagged.push(input);
        return { key: "ff-core-program", description: "", default: false, enabled: true };
      },
    });

    fireEvent.click(await screen.findByRole("button", { name: "Turn it on" }));

    // Waited on the call, not on the button coming back: while the mutation is in flight the
    // button is in its loading state, so re-finding it by name races the request.
    await waitFor(() => expect(flagged).toHaveLength(1));
    expect(flagged[0]).toEqual({ key: "ff-core-program", enabled: true });
  });

  it("disappears once nothing is missing, rather than sitting at 7/7 forever", async () => {
    const { container } = renderWithTrpc(<WorkspaceSetupCard />, {
      "workspace.setup": () =>
        setup({
          ready: true,
          steps: setup().steps.map((s) => ({ ...s, done: true, blockedBy: null })),
        }),
    });

    // Nothing rendered at all — a finished checklist is furniture, not information.
    expect(container.textContent).toBe("");
  });

  it("says nothing while the answer is still unknown", async () => {
    // A card that flashed "0/7" on every page load would report a fresh install's state to
    // someone whose workspace is fully configured.
    const { container } = renderWithTrpc(<WorkspaceSetupCard />, {});
    expect(container.textContent).toBe("");
  });
});
