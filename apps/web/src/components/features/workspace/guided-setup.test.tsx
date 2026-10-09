/// <reference types="bun-types" />
import { afterEach, describe, expect, it } from "bun:test";
import type { ExecutorImageBuildStatus, WorkspaceSetupDto } from "@solow/contracts";
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
  executorReplaceable: false,
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

const IMAGE = "solow-executor:local";
const noDocker = () => ({
  available: false,
  reason: "docker: not found",
  executorImage: { name: IMAGE, present: false },
});
const dockerWithImage = (present: boolean) => () => ({
  available: true,
  reason: null,
  executorImage: { name: IMAGE, present },
});
/** Where the orchestrator's build of that image is (roadmap B4). */
const imageBuild = (over: Partial<ExecutorImageBuildStatus> = {}): ExecutorImageBuildStatus => ({
  image: IMAGE,
  state: "idle",
  startedAt: null,
  finishedAt: null,
  output: [],
  reason: null,
  ...over,
});

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
      "profile.executor.dockerAvailability": dockerWithImage(false),
      "profile.executor.imageBuild": () => imageBuild(),
    });

    expect(
      await screen.findByText("It works with your access, without asking first"),
    ).toBeDefined();
    // Docker is there but the image with Claude Code in it is not: offer to build it, here, with
    // the commands beside the button for whoever would rather use a terminal.
    expect(await screen.findByText(/Docker is installed here/)).toBeDefined();
    expect(
      await screen.findByRole("button", { name: "Build the isolated environment" }),
    ).toBeDefined();
    expect(screen.getByText("npx @satcomx00-x00/solow executor-image")).toBeDefined();
    expect(screen.getByText("make executor-image")).toBeDefined();
  });

  it("builds the image from the setup, shows it running, and then plans the container", async () => {
    let present = false;
    let state: ExecutorImageBuildStatus = imageBuild();
    const started: unknown[] = [];
    renderWithTrpc(<GuidedSetup />, {
      "workspace.setup": () => bare(),
      "profile.executor.dockerAvailability": () => dockerWithImage(present)(),
      "profile.executor.imageBuild": () => state,
      "profile.executor.buildImage": () => {
        started.push(true);
        state = imageBuild({
          state: "building",
          startedAt: new Date().toISOString(),
          output: ["#5 [harnesses 2/2] RUN npm install --global"],
        });
        return state;
      },
    });

    fireEvent.click(await screen.findByRole("button", { name: "Build the isolated environment" }));

    // Running: said once in the live region, with Docker's newest line beside it.
    expect(
      await screen.findByText("Building the image on this machine. It takes a few minutes."),
    ).toBeDefined();
    expect(screen.getByText("#5 [harnesses 2/2] RUN npm install --global")).toBeDefined();
    expect(screen.getByRole("button", { name: "Building…" })).toHaveProperty("disabled", true);
    expect(started).toHaveLength(1);

    // The next poll finds it built; the availability check is asked again, and the plan moves.
    present = true;
    state = imageBuild({
      state: "succeeded",
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    });
    expect(
      await screen.findByText(/in an isolated container on this machine/, {}, { timeout: 5_000 }),
    ).toBeDefined();
    expect(screen.queryByText("It works with your access, without asking first")).toBeNull();
  });

  it("says why a build failed, shows what Docker printed, and offers it again", async () => {
    renderWithTrpc(<GuidedSetup />, {
      "workspace.setup": () => bare(),
      "profile.executor.dockerAvailability": dockerWithImage(false),
      "profile.executor.imageBuild": () =>
        imageBuild({
          state: "failed",
          startedAt: "2026-10-09T12:00:00.000Z",
          finishedAt: "2026-10-09T12:01:00.000Z",
          output: ["ERROR: failed to resolve source metadata: dial tcp: i/o timeout"],
          reason: "The build couldn't download what it needs.",
        }),
    });

    expect(await screen.findByText("The build couldn't download what it needs.")).toBeDefined();
    expect(screen.getByText("What Docker printed")).toBeDefined();
    expect(screen.getByRole("button", { name: "Try again" })).toBeDefined();
    expect(screen.getByText("npx @satcomx00-x00/solow executor-image")).toBeDefined();
  });

  it("does not claim a build it did not watch, and says so when nothing could start one", async () => {
    renderWithTrpc(<GuidedSetup />, {
      "workspace.setup": () => bare(),
      "profile.executor.dockerAvailability": dockerWithImage(false),
      // Built at some point, but the image is not here now: offer to build it again.
      "profile.executor.imageBuild": () =>
        imageBuild({
          state: "succeeded",
          startedAt: "2026-10-01T12:00:00.000Z",
          finishedAt: "2026-10-01T12:05:00.000Z",
        }),
      "profile.executor.buildImage": () => null,
    });

    const button = await screen.findByRole("button", { name: "Build the isolated environment" });
    expect(screen.queryByText("The image is built.")).toBeNull();
    fireEvent.click(button);
    expect(await screen.findByText(/SoloW's agent runner did not answer/)).toBeDefined();
  });

  it("says Claude will work in the isolated container once its image is built", async () => {
    renderWithTrpc(<GuidedSetup />, {
      "workspace.setup": () => bare(),
      "profile.executor.dockerAvailability": dockerWithImage(true),
    });

    expect(await screen.findByText(/in an isolated container on this machine/)).toBeDefined();
    expect(screen.getByText(IMAGE)).toBeDefined();
    expect(screen.queryByText("It works with your access, without asking first")).toBeNull();
  });

  it("moves the setup's own local executor into the container when connecting again", async () => {
    renderWithTrpc(<GuidedSetup />, {
      "workspace.setup": () => connected({ executorReplaceable: true }),
      "profile.executor.dockerAvailability": dockerWithImage(true),
    });
    // The first "Change" is the Connect Claude step's: the steps are listed in order.
    const [change] = await screen.findAllByRole("button", { name: "Change" });
    if (!change) throw new Error("no Change button");
    fireEvent.click(change);

    expect(await screen.findByText(/in an isolated container on this machine/)).toBeDefined();
  });

  it("leaves a local executor the Owner chose alone, and points at Settings instead", async () => {
    renderWithTrpc(<GuidedSetup />, {
      "workspace.setup": () => connected({ executorReplaceable: false }),
      "profile.executor.dockerAvailability": dockerWithImage(true),
    });
    // The first "Change" is the Connect Claude step's: the steps are listed in order.
    const [change] = await screen.findAllByRole("button", { name: "Change" });
    if (!change) throw new Error("no Change button");
    fireEvent.click(change);

    expect(
      await screen.findByText("It works with your access, without asking first"),
    ).toBeDefined();
    expect(await screen.findByRole("link", { name: "Set one up in Settings" })).toBeDefined();
    expect(screen.queryByText(/executor-image/)).toBeNull();
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

  it("sends a container setup to the image, not to installing Claude on this machine", async () => {
    // The test runs where the setup's Tasks run (roadmap B4), so a missing harness in a
    // container setup is a missing harness in the image.
    let problem: "not-installed" | "executor" = "not-installed";
    renderWithTrpc(<GuidedSetup />, {
      "workspace.setup": () => connected({ executorKind: "docker" }),
      "profile.executor.dockerAvailability": dockerWithImage(true),
      "profile.executor.imageBuild": () => imageBuild(),
      "setup.test": () => ({
        ok: false,
        problem,
        fixStep: null,
        harness: "Claude Code",
        answered: false,
      }),
    });

    fireEvent.click(await screen.findByRole("button", { name: "Run the test" }));
    expect(
      await screen.findByText(/Claude Code isn't in the container image Claude runs in/),
    ).toBeDefined();
    expect(screen.queryByText(/npm install -g/)).toBeNull();
    // Rebuilt from here, not from a terminal.
    expect(await screen.findByRole("button", { name: "Rebuild the image" })).toBeDefined();

    problem = "executor";
    fireEvent.click(screen.getByRole("button", { name: "Run the test again" }));
    expect(
      await screen.findByText(/SoloW couldn't start the isolated container Claude runs in/),
    ).toBeDefined();
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
