/// <reference types="bun-types" />
import { afterEach, describe, expect, it } from "bun:test";
import type { WorkspaceSetupDto } from "@solow/contracts";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithTrpc } from "@/test/trpc-harness";
import { GuidedSetup } from "./guided-setup";
import { repositoryNameFrom } from "./setup-steps";

/**
 * The guided setup (roadmap E1): connect Claude, choose a repository, try it.
 *
 * What these pin is what made it worth replacing the checklist for: one question where there
 * were four Settings screens, the newcomer's words rather than the schema's, the host-run warning
 * before the choice rather than after it, and a failed test that says what to fix in a sentence.
 */

// No global auto-cleanup under the bun runner: without it each render stacks on the last.
afterEach(cleanup);

const workspace = { id: "ws-1", name: "My workspace", createdAt: "2026-08-01T00:00:00.000Z" };

const bare = (over: Partial<WorkspaceSetupDto> = {}): WorkspaceSetupDto => ({
  workspace,
  coreLoop: true,
  steps: [
    { key: "claude", done: false, detail: "", blockedBy: null },
    { key: "repository", done: false, detail: "", blockedBy: null },
    { key: "test", done: false, detail: "", blockedBy: "claude" },
  ],
  agent: null,
  executorKind: null,
  ready: false,
  ...over,
});

const connected = (over: Partial<WorkspaceSetupDto> = {}): WorkspaceSetupDto =>
  bare({
    steps: [
      { key: "claude", done: true, detail: "Claude Code · subscription", blockedBy: null },
      { key: "repository", done: true, detail: "solow", blockedBy: null },
      { key: "test", done: false, detail: "", blockedBy: null },
    ],
    agent: { harness: "Claude Code", billing: "subscription", permissionMode: "bypassPermissions" },
    executorKind: "local",
    ...over,
  });

const ready = (): WorkspaceSetupDto =>
  connected({
    steps: [
      { key: "claude", done: true, detail: "Claude Code · subscription", blockedBy: null },
      { key: "repository", done: true, detail: "solow", blockedBy: null },
      { key: "test", done: true, detail: "Passed", blockedBy: null },
    ],
    ready: true,
  });

const noDocker = () => ({ available: false, reason: "docker: not found" });

describe("GuidedSetup", () => {
  it("opens on Connect Claude and asks only how you pay and the token", async () => {
    renderWithTrpc(<GuidedSetup />, {
      "workspace.setup": () => bare(),
      "profile.executor.dockerAvailability": noDocker,
    });

    expect(await screen.findByText("0 of 3 done")).toBeDefined();
    expect(screen.getByRole("radio", { name: /Claude subscription/ })).toBeDefined();
    expect(screen.getByLabelText("Subscription token")).toBeDefined();
    expect(screen.getByText("claude setup-token")).toBeDefined();
    // None of the objects it makes underneath are named while setting up.
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/profile/i);
    expect(text).not.toMatch(/secret/i);
  });

  it("says Claude will run unattended on this machine before Connect is pressed", async () => {
    renderWithTrpc(<GuidedSetup />, {
      "workspace.setup": () => bare(),
      "profile.executor.dockerAvailability": () => ({ available: true, reason: null }),
    });

    expect(
      await screen.findByText("It works with your access, without asking first"),
    ).toBeDefined();
    // Docker is there, but a container needs an image with Claude Code in it — offered, not made.
    expect(await screen.findByText(/Docker is installed here/)).toBeDefined();
  });

  it("sends the billing mode and the credential in one call", async () => {
    const sent: unknown[] = [];
    renderWithTrpc(<GuidedSetup />, {
      "workspace.setup": () => bare(),
      "profile.executor.dockerAvailability": noDocker,
      "setup.connectClaude": (input) => {
        sent.push(input);
        return {
          harnessProfileId: "hp-1",
          executorProfileId: "ex-1",
          executorKind: "local",
          createdExecutor: true,
          resumedTaskCount: 0,
        };
      },
    });

    fireEvent.click(await screen.findByRole("radio", { name: /Anthropic API key/ }));
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "sk-ant-api03-x" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect Claude" }));

    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({ billing: "api_key", credential: "sk-ant-api03-x" });
  });

  it("names the repository from its path and refuses a relative one in words", async () => {
    const sent: unknown[] = [];
    renderWithTrpc(<GuidedSetup />, {
      "workspace.setup": () =>
        connected({
          steps: [
            { key: "claude", done: true, detail: "Claude Code · subscription", blockedBy: null },
            { key: "repository", done: false, detail: "", blockedBy: null },
            { key: "test", done: false, detail: "", blockedBy: null },
          ],
        }),
      "repository.connect": (input) => {
        sent.push(input);
        return {};
      },
    });

    const field = await screen.findByLabelText("Full path");
    fireEvent.change(field, { target: { value: "code/app" } });
    fireEvent.click(screen.getByRole("button", { name: "Use this repository" }));
    expect(await screen.findByText("Use the full path, starting with /.")).toBeDefined();
    expect(sent).toHaveLength(0);

    fireEvent.change(field, { target: { value: "/home/me/code/app/" } });
    expect(screen.getByText("It will be called “app”.")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Use this repository" }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({ name: "app", source: "local_path", location: "/home/me/code/app/" });
  });

  it("explains a refused credential in a sentence and goes back to the step that fixes it", async () => {
    renderWithTrpc(<GuidedSetup />, {
      "workspace.setup": () => connected(),
      "profile.executor.dockerAvailability": noDocker,
      "setup.test": () => ({
        ok: false,
        problem: "credential",
        fixStep: "claude",
        harness: "Claude Code",
        answered: false,
      }),
    });

    fireEvent.click(await screen.findByRole("button", { name: "Run the test" }));

    expect(
      await screen.findByText(/Claude didn't accept your token\. Go back to Connect Claude/),
    ).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Go to Connect Claude" }));
    expect(await screen.findByLabelText("Subscription token")).toBeDefined();
  });

  it("puts the core loop's switch first when someone turned it off", async () => {
    const flagged: unknown[] = [];
    renderWithTrpc(<GuidedSetup />, {
      "workspace.setup": () => bare({ coreLoop: false }),
      "flag.set": (input) => {
        flagged.push(input);
        return { key: "ff-core-program", description: "", default: true, enabled: true };
      },
    });

    fireEvent.click(await screen.findByRole("button", { name: "Turn it back on" }));

    await waitFor(() => expect(flagged).toEqual([{ key: "ff-core-program", enabled: true }]));
    // Nothing below can be saved while it is off, so no form is offered.
    expect(screen.queryByRole("button", { name: "Connect Claude" })).toBeNull();
  });

  it("gets out of the way on the projects page once the workspace is ready", async () => {
    const { container } = renderWithTrpc(<GuidedSetup />, { "workspace.setup": () => ready() });

    await waitFor(() => expect(container.textContent).toBe(""));
  });

  it("says nothing while the answer is still unknown", () => {
    const { container } = renderWithTrpc(<GuidedSetup />, {});
    expect(container.textContent).toBe("");
  });

  it("stays available to run again from Settings, every step reopenable", async () => {
    renderWithTrpc(<GuidedSetup mode="rerun" />, {
      "workspace.setup": () => ready(),
      "profile.executor.dockerAvailability": noDocker,
    });

    expect(await screen.findByText("3 of 3 done")).toBeDefined();
    const change = screen.getAllByRole("button", { name: "Change" });
    expect(change).toHaveLength(3);
    fireEvent.click(change[0] as HTMLElement);
    expect(await screen.findByText(/Connected: Claude Code · subscription/)).toBeDefined();
  });
});

describe("repositoryNameFrom", () => {
  it("infers the name the Owner would have typed", () => {
    expect(repositoryNameFrom("/home/me/code/app")).toBe("app");
    expect(repositoryNameFrom("/home/me/code/app/")).toBe("app");
    expect(repositoryNameFrom("https://github.com/me/app.git")).toBe("app");
    expect(repositoryNameFrom("git@github.com:me/app.git")).toBe("app");
  });
});
