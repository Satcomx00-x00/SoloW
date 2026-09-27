/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithTrpc } from "@/test/trpc-harness";
import { CreateTaskDialog } from "./create-task-dialog";

/**
 * The Task-creation Issue picker, filtered by the chosen Repository (user report: "the issue
 * picker in Task creation should auto-populate from the selected Repository").
 */

const handlers = {
  "issue.list": () => ({
    items: [
      {
        id: "issue-1",
        title: "Ship it",
        description: "The upload endpoint rejects files over 2 MB.",
        status: "open",
        taskCount: 0,
        labels: ["bug"],
        source: "github",
        externalNumber: 42,
        externalUrl: "https://github.com/acme/api/issues/42",
        externalId: null,
        externalParentId: null,
      },
    ],
    nextCursor: null,
  }),
  "profile.agent.list": () => ({ items: [{ id: "harness-1", name: "Claude" }], nextCursor: null }),
  "profile.executor.list": () => ({ items: [{ id: "exec-1", name: "Local" }], nextCursor: null }),
  "repository.list": () => ({
    items: [
      { id: "repo-1", name: "api", source: "local_path", location: "/srv/api" },
      { id: "repo-2", name: "shared-lib", source: "local_path", location: "/srv/lib" },
    ],
    nextCursor: null,
  }),
  "task.list": () => ({ items: [], nextCursor: null }),
  "task.create": (input: unknown) => ({ id: "task-1", ...(input as object) }),
  /** No stored defaults unless a case says otherwise — the form opens on its own blanks. */
  "preference.getTaskDefaults": () => ({
    workspaceId: "ws-1",
    userId: "ada",
    defaults: { harnessProfileId: null, executorProfileId: null },
  }),
};

/** The same server, with the Owner having chosen what a new Task starts as (spec F16). */
const withDefaults = {
  ...handlers,
  "preference.getTaskDefaults": () => ({
    workspaceId: "ws-1",
    userId: "ada",
    defaults: { harnessProfileId: "harness-1", executorProfileId: "exec-1" },
  }),
};

async function pick(label: string, option: string): Promise<void> {
  fireEvent.click(await screen.findByRole("combobox", { name: label }));
  fireEvent.click(await screen.findByRole("option", { name: option }));
}

afterEach(cleanup);

describe("CreateTaskDialog — Issue picker filtered by Repository", () => {
  it("re-queries issue.list with the chosen Repository's id once one is picked", async () => {
    const { log } = renderWithTrpc(<CreateTaskDialog />, handlers);
    fireEvent.click(await screen.findByRole("button", { name: "New task" }));
    // Unfiltered on first open — nothing chosen yet.
    await waitFor(() => {
      expect(log.calls.some((c) => c.path === "issue.list")).toBe(true);
    });

    await pick("Repository", "api");

    await waitFor(() => {
      const filtered = log.calls.filter(
        (c) => c.path === "issue.list" && (c.input as { repositoryId?: string }).repositoryId,
      );
      expect(filtered.length).toBeGreaterThan(0);
    });
    const last = log.calls.filter((c) => c.path === "issue.list").at(-1);
    expect(last).toBeDefined();
    expect((last?.input as { repositoryId?: string } | undefined)?.repositoryId).toBe("repo-1");
  });

  it("clears a previously chosen Issue when the Repository changes underneath it", async () => {
    renderWithTrpc(<CreateTaskDialog />, handlers);
    fireEvent.click(await screen.findByRole("button", { name: "New task" }));

    await pick("Repository", "api");
    await pick("Issue", "Ship it");
    expect((await screen.findByRole("combobox", { name: "Issue" })).textContent).toContain(
      "Ship it",
    );

    await pick("Repository", "shared-lib");

    // The Issue field reverts to its placeholder — the previous pick did not silently ride along
    // onto a Repository it was never chosen for.
    expect((await screen.findByRole("combobox", { name: "Issue" })).textContent).not.toContain(
      "Ship it",
    );
  });

  it("labels the Issue picker's placeholder to say a Repository comes first", async () => {
    renderWithTrpc(<CreateTaskDialog />, handlers);
    fireEvent.click(await screen.findByRole("button", { name: "New task" }));

    expect(screen.getByText("Select a repository first")).toBeDefined();
  });
});

/**
 * A caller's starting point, applied to the form.
 *
 * The `preset` prop is the *only* path in now: this dialog used to subscribe to a document-level
 * create bus as well, and both went when the shell header's Create menu that dispatched on it was
 * removed. The two surfaces left — an Issue's own page and a project row's right-click — mount
 * this dialog themselves and hand the preset down.
 */
describe("CreateTaskDialog — a caller's preset", () => {
  it("applies a caller's preset, repository first, so the Issue it names is actually reachable", async () => {
    /*
     * Repository *before* Issue is the whole property. The Issue picker is narrowed by the chosen
     * Repository and sits disabled on "Select a repository first" until one is set, so an
     * implementation that wrote `issueId` alone would leave a value in the form that nothing on
     * screen could show — a preset that looks like it did nothing, which is exactly how this bug
     * presented the first time.
     *
     * It also catches the other half of the removal: deleting the bus subscription *and* the
     * `open && preset` effect together would leave both remaining callers opening an empty form
     * with nothing to say it had been asked for a particular Issue.
     */
    renderWithTrpc(
      <CreateTaskDialog
        trigger={null}
        open
        preset={{ repositoryId: "repo-1", issueId: "issue-1" }}
      />,
      handlers,
    );

    expect((await screen.findByRole("combobox", { name: "Repository" })).textContent).toContain(
      "api",
    );
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Issue" }).textContent).toContain("Ship it"),
    );
    // The picker resolved the id to a real Issue, rather than holding an id it could not draw.
    expect(await screen.findByRole("region", { name: "Selected issue" })).toBeDefined();
  });

  it("names the Task after a preset Issue, not only a hand-picked one", async () => {
    /*
     * The regression this case exists for. Naming the Task after its Issue used to hang off the
     * picker's `onChange`, so it fired for an Issue chosen by hand and never for one arriving in
     * a preset — which is every Task cut from an Issue's own page, i.e. the common path. The
     * form opened with an empty Title and the Owner retyped what was already on screen.
     */
    renderWithTrpc(
      <CreateTaskDialog
        trigger={null}
        open
        preset={{ repositoryId: "repo-1", issueId: "issue-1" }}
      />,
      handlers,
    );

    await waitFor(() =>
      expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe("Ship it"),
    );
  });
});

/**
 * What a new Task starts as (spec F16).
 *
 * A default, never a lock: both pickers stay editable and an answer the Owner gave is never
 * overwritten. These pin both halves, because a "default" that clobbered a deliberate choice
 * would be worse than no default at all.
 */
describe("CreateTaskDialog — the Owner's stored defaults", () => {
  it("opens with the stored harness and executor already chosen", async () => {
    renderWithTrpc(<CreateTaskDialog />, withDefaults);
    fireEvent.click(await screen.findByRole("button", { name: "New task" }));

    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Harness profile" }).textContent).toContain(
        "Claude",
      ),
    );
    expect(screen.getByRole("combobox", { name: "Executor" }).textContent).toContain("Local");
  });

  it("opens both pickers empty when nothing is stored", async () => {
    renderWithTrpc(<CreateTaskDialog />, handlers);
    fireEvent.click(await screen.findByRole("button", { name: "New task" }));

    expect(
      (await screen.findByRole("combobox", { name: "Harness profile" })).textContent,
    ).not.toContain("Claude");
  });

  it("still sends the stored pair on submit, so the default is a real answer", async () => {
    const { log } = renderWithTrpc(
      <CreateTaskDialog
        trigger={null}
        open
        preset={{ repositoryId: "repo-1", issueId: "issue-1" }}
      />,
      withDefaults,
    );

    await waitFor(() =>
      expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe("Ship it"),
    );
    // Submitted on the form rather than by clicking the button: the click-to-submit path is the
    // browser's, and the test DOM does not implement it.
    const submit = screen.getByRole("button", { name: "Create task" }) as HTMLButtonElement;
    fireEvent.submit(submit.closest("form") as HTMLFormElement);

    await waitFor(() => {
      const created = log.calls.filter((c) => c.path === "task.create").at(-1);
      // The point of the whole feature: an Issue, two clicks fewer, and a Task that launches.
      expect(created?.input).toMatchObject({
        issueId: "issue-1",
        title: "Ship it",
        agentProfileId: "harness-1",
        executorProfileId: "exec-1",
      });
    });
  });
});

/**
 * What the Owner can see of the Issue they are launching a harness against.
 *
 * The picker is a Select, so it showed one truncated line and nothing else: the brief for a run
 * was being chosen from a fragment of itself. These pin the whole Issue being on screen, and the
 * Task taking its name from it without overwriting a name a person typed.
 */
describe("CreateTaskDialog — the chosen Issue", () => {
  async function openAndPick(): Promise<void> {
    renderWithTrpc(<CreateTaskDialog />, handlers);
    fireEvent.click(await screen.findByRole("button", { name: "New task" }));
    await pick("Repository", "api");
    await pick("Issue", "Ship it");
  }

  it("shows the body, the labels and the link back to the provider", async () => {
    await openAndPick();

    const preview = await screen.findByRole("region", { name: "Selected issue" });
    expect(preview.textContent).toContain("The upload endpoint rejects files over 2 MB.");
    expect(preview.textContent).toContain("bug");
    expect(preview.textContent).toContain("#42");
    expect(preview.querySelector("a")?.getAttribute("href")).toBe(
      "https://github.com/acme/api/issues/42",
    );
  });

  it("names the task after the issue", async () => {
    await openAndPick();
    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe("Ship it");
  });

  it("leaves a title the owner typed alone", async () => {
    // Picking an Issue after writing your own title must not throw the title away — the whole
    // point of an editable field is that the edit survives.
    renderWithTrpc(<CreateTaskDialog />, handlers);
    fireEvent.click(await screen.findByRole("button", { name: "New task" }));
    fireEvent.change(await screen.findByLabelText("Title"), { target: { value: "My own name" } });

    await pick("Repository", "api");
    await pick("Issue", "Ship it");

    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe("My own name");
  });
});
