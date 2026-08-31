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
  "profile.agent.list": () => ({ items: [{ id: "agent-1", name: "Claude" }], nextCursor: null }),
  "profile.executor.list": () => ({ items: [{ id: "exec-1", name: "Local" }], nextCursor: null }),
  "repository.list": () => ({
    items: [
      { id: "repo-1", name: "api", source: "local_path", location: "/srv/api" },
      { id: "repo-2", name: "shared-lib", source: "local_path", location: "/srv/lib" },
    ],
    nextCursor: null,
  }),
  "task.list": () => ({ items: [], nextCursor: null }),
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
});

/**
 * What the Owner can see of the Issue they are launching an agent against.
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
